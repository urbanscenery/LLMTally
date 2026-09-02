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
 * good number is a valid lower bound right up to the reset. A missing
 * or absurdly-far reset falls back to the 24h policy.
 *
 * Once a window's own reset has passed, though, no policy saves it:
 * utilization went to zero at that boundary, so the stored number no
 * longer bounds anything — it describes a period that ended. Serving it
 * would pair a stale percentage with "resets soon", which reads as
 * current. This binds hardest where polling stops for a whole period:
 * Grok's token sleeps after ~6h, so a week away would otherwise show
 * last week's number all the way through the new week.
 */
function isWindowTrusted(row: SampleRow, request: StoredLastGoodRequest): boolean {
  if (row.resets_at_utc !== null && row.resets_at_utc <= request.nowUtc) {
    return false;
  }
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
  /** Receives a human-readable reason when history existed but was rejected. */
  rejectionNotes?: string[],
): QuotaSnapshot | null {
  if (request.failure?.kind === 'auth_invalid' || request.failure?.kind === 'no_subscription') {
    // a rejected credential invalidates its own history: the numbers
    // may still be true, but nothing can confirm that any more. A
    // lapsed subscription invalidates it just as hard — the stored
    // windows belonged to the paid plan that ended
    return null;
  }
  // the stable id is the lookup key when the caller has one. Rows
  // recorded before ids existed carry '' — they used to be reachable
  // through a display-label OR, but the same label can belong to two
  // accounts (personal and organization), so that fallback could serve
  // another account's numbers. Id-less rows age out with the 30-day
  // retention instead.
  //
  // "Newest row per window" is a single ordered pass over the covering
  // index (007), not a correlated MAX — that form re-scanned the whole
  // account history per row and went quadratic with sample count.
  const rows = (
    request.accountId !== null
      ? db
          .query<SampleRow, [string, string]>(
            `SELECT window_id, used_percent, resets_at_utc, observed_at_utc
             FROM (
               SELECT window_id, used_percent, resets_at_utc, observed_at_utc,
                      ROW_NUMBER() OVER (
                        PARTITION BY window_id ORDER BY observed_at_utc DESC
                      ) AS recency
               FROM quota_samples
               WHERE agent = ? AND account_id = ?
             )
             WHERE recency = 1
             ORDER BY window_id`,
          )
          .all(request.agent, request.accountId)
      : db
          .query<SampleRow, [string, string]>(
            `SELECT window_id, used_percent, resets_at_utc, observed_at_utc
             FROM (
               SELECT window_id, used_percent, resets_at_utc, observed_at_utc,
                      ROW_NUMBER() OVER (
                        PARTITION BY window_id ORDER BY observed_at_utc DESC
                      ) AS recency
               FROM quota_samples
               WHERE agent = ? AND account = ?
             )
             WHERE recency = 1
             ORDER BY window_id`,
          )
          .all(request.agent, request.account ?? '')
  );
  const trusted = rows.filter((row) => isWindowTrusted(row, request));
  if (trusted.length === 0) {
    // a blank gauge with history sitting right there is the confusing
    // case — name the reason instead of leaving "why empty?" to guesses
    if (rows.length > 0 && rejectionNotes !== undefined) {
      const resetPassed = rows.filter(
        (row) => row.resets_at_utc !== null && row.resets_at_utc <= request.nowUtc,
      ).length;
      const agedOut = rows.length - resetPassed;
      const parts: string[] = [];
      if (resetPassed > 0) {
        parts.push(`${resetPassed} window(s) past their reset`);
      }
      if (agedOut > 0) {
        parts.push(`${agedOut} older than 24h`);
      }
      rejectionNotes.push(`stored history exists but was not trusted: ${parts.join(', ')}`);
    }
    return null;
  }
  const observedAtUtc = Math.max(...trusted.map((row) => row.observed_at_utc));
  const windows: QuotaWindow[] = trusted.map((row) => ({
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
