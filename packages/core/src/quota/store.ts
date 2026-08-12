/**
 * Quota history persistence: every successful quota reading becomes a
 * sample row (per agent/account/window), giving a stored last-good
 * fallback when live sources fail and a future time-series for charts.
 * A failed reading never overwrites the last good one, and stale data is
 * served marked rather than fabricated.
 */
import type { Database } from 'bun:sqlite';

import type { AccountProfile } from '../accounts/discovery.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { QuotaFailure, QuotaSnapshot, QuotaWindow } from './providers.ts';

const RETENTION_SECONDS = 30 * 24 * 3600;
const STORED_FALLBACK_MAX_AGE_SECONDS = 24 * 3600;
/** A stored `resets_at` farther out than this is treated as damaged. */
const MAX_REASONABLE_RESET_HORIZON_SECONDS = 32 * 24 * 3600;

const INSERT_SAMPLE_SQL = `INSERT INTO quota_samples
  (agent, account, account_id, window_id, used_percent, resets_at_utc, source, observed_at_utc, recorded_at_utc)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (agent, account, account_id, window_id, observed_at_utc) DO NOTHING`;

const UPSERT_PROFILE_SQL = `INSERT INTO account_profiles
  (agent, account_id, display_label, email, organization_id, discovered_via, first_seen_utc, last_seen_utc)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (agent, account_id) DO UPDATE SET
   display_label = excluded.display_label,
   email = excluded.email,
   organization_id = excluded.organization_id,
   discovered_via = excluded.discovered_via,
   last_seen_utc = excluded.last_seen_utc`;

export function recordQuotaSamples(
  db: Database,
  snapshots: readonly QuotaSnapshot[],
  nowUtc: number,
): number {
  const insert = db.prepare(INSERT_SAMPLE_SQL);
  let inserted = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const snapshot of snapshots) {
      for (const window of snapshot.windows) {
        const changes = insert.run(
          snapshot.agent,
          snapshot.account ?? '',
          snapshot.accountId ?? '',
          window.id,
          window.usedPercent,
          window.resetsAtUtc,
          snapshot.source,
          snapshot.observedAtUtc,
          nowUtc,
        );
        inserted += Number(changes.changes);
      }
    }
    db.run('DELETE FROM quota_samples WHERE recorded_at_utc < ?', [nowUtc - RETENTION_SECONDS]);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return inserted;
}

export function upsertAccountProfiles(
  db: Database,
  profiles: readonly AccountProfile[],
  nowUtc: number,
): void {
  const upsert = db.prepare(UPSERT_PROFILE_SQL);
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const profile of profiles) {
      upsert.run(
        profile.agent,
        profile.accountId,
        profile.displayLabel,
        profile.email,
        profile.organizationId,
        profile.discoveredVia,
        nowUtc,
        nowUtc,
      );
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

interface SampleRow {
  readonly window_id: string;
  readonly used_percent: number;
  readonly resets_at_utc: number | null;
  readonly observed_at_utc: number;
}

export interface StoredLastGoodRequest {
  readonly agent: string;
  readonly accountId: string | null;
  readonly account: string | null;
  readonly nowUtc: number;
  /** The failure of the live read this fallback is standing in for. */
  readonly failure: QuotaFailure | null;
}

/**
 * Per-window trust decision. The normal shelf life is 24h. When the
 * live read failed with a 429 the sample stays trustworthy until its
 * own `resets_at`: a usage-endpoint 429 is a polling throttle, not a
 * quota change, and utilization only rises within a window — the last
 * good number is a valid lower bound right up to the reset. A missing,
 * past, or absurdly-far reset falls back to the 24h policy.
 */
function isWindowTrusted(row: SampleRow, request: StoredLastGoodRequest): boolean {
  if (row.observed_at_utc >= request.nowUtc - STORED_FALLBACK_MAX_AGE_SECONDS) {
    return true;
  }
  return (
    request.failure?.kind === 'rate_limited' &&
    row.resets_at_utc !== null &&
    row.resets_at_utc > request.nowUtc &&
    row.resets_at_utc <= request.nowUtc + MAX_REASONABLE_RESET_HORIZON_SECONDS
  );
}

/**
 * Latest stored reading per window for one agent/account, as a
 * `stored_history` snapshot — used only when every live/cached source
 * came back empty. Each window is judged independently by
 * `isWindowTrusted`, so a 429 can extend one window's trust while a
 * reset-less sibling still ages out at 24h.
 */
export function readStoredLastGood(
  db: Database,
  request: StoredLastGoodRequest,
): QuotaSnapshot | null {
  if (request.failure?.kind === 'auth_invalid') {
    // a rejected credential invalidates its own history: the numbers
    // may still be true, but nothing can confirm that any more
    return null;
  }
  // the stable id is the lookup key when the caller has one; rows
  // recorded before the id existed carry '' and stay reachable via
  // their display label
  const rows = (
    request.accountId !== null
      ? db
          .query<SampleRow, [string, string, string, string, string]>(
            `SELECT window_id, used_percent, resets_at_utc, observed_at_utc
             FROM quota_samples
             WHERE agent = ?
               AND (account_id = ? OR (account_id = '' AND account = ?))
               AND observed_at_utc = (
                 SELECT MAX(s2.observed_at_utc) FROM quota_samples s2
                 WHERE s2.agent = quota_samples.agent
                   AND s2.window_id = quota_samples.window_id
                   AND (s2.account_id = ? OR (s2.account_id = '' AND s2.account = ?))
               )
             ORDER BY window_id`,
          )
          .all(
            request.agent,
            request.accountId,
            request.account ?? '',
            request.accountId,
            request.account ?? '',
          )
      : db
          .query<SampleRow, [string, string]>(
            `SELECT window_id, used_percent, resets_at_utc, observed_at_utc
             FROM quota_samples
             WHERE agent = ? AND account = ?
               AND observed_at_utc = (
                 SELECT MAX(s2.observed_at_utc) FROM quota_samples s2
                 WHERE s2.agent = quota_samples.agent AND s2.account = quota_samples.account
                   AND s2.window_id = quota_samples.window_id
               )
             ORDER BY window_id`,
          )
          .all(request.agent, request.account ?? '')
  ).filter((row) => isWindowTrusted(row, request));
  if (rows.length === 0) {
    return null;
  }
  const observedAtUtc = Math.max(...rows.map((row) => row.observed_at_utc));
  const windows: QuotaWindow[] = rows.map((row) => ({
    id: row.window_id,
    usedPercent: row.used_percent,
    resetsAtUtc: row.resets_at_utc,
  }));
  const hours = Math.floor((request.nowUtc - observedAtUtc) / 3600);
  const warnings: string[] = [];
  if (hours >= 1) {
    warnings.push(`stored reading is ${hours}h old (last good)`);
  }
  if (request.failure?.kind === 'rate_limited' && hours >= 24) {
    warnings.push('shown despite its age: usage cannot have decreased before the window resets');
  }
  return makeQuotaSnapshot({
    agent: request.agent,
    accountId: request.accountId,
    account: request.account,
    source: 'stored_history',
    observedAtUtc,
    windows,
    warnings,
  });
}
