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
import type { QuotaSnapshot, QuotaWindow } from './providers.ts';

const RETENTION_SECONDS = 30 * 24 * 3600;
const STORED_FALLBACK_MAX_AGE_SECONDS = 24 * 3600;

const INSERT_SAMPLE_SQL = `INSERT INTO quota_samples
  (agent, account, window_id, used_percent, resets_at_utc, source, observed_at_utc, recorded_at_utc)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (agent, account, window_id, observed_at_utc) DO NOTHING`;

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

/**
 * Latest stored reading per window for one agent/account, as a
 * `stored_history` snapshot — used only when every live/cached source
 * came back empty. Readings older than 24h are not worth showing.
 */
export function readStoredLastGood(
  db: Database,
  agent: string,
  account: string | null,
  nowUtc: number,
): QuotaSnapshot | null {
  const rows = db
    .query<SampleRow, [string, string, number]>(
      `SELECT window_id, used_percent, resets_at_utc, observed_at_utc
       FROM quota_samples
       WHERE agent = ? AND account = ? AND observed_at_utc >= ?
         AND observed_at_utc = (
           SELECT MAX(observed_at_utc) FROM quota_samples s2
           WHERE s2.agent = quota_samples.agent AND s2.account = quota_samples.account
             AND s2.window_id = quota_samples.window_id
         )
       ORDER BY window_id`,
    )
    .all(agent, account ?? '', nowUtc - STORED_FALLBACK_MAX_AGE_SECONDS);
  if (rows.length === 0) {
    return null;
  }
  const observedAtUtc = Math.max(...rows.map((row) => row.observed_at_utc));
  const windows: QuotaWindow[] = rows.map((row) => ({
    id: row.window_id,
    usedPercent: row.used_percent,
    resetsAtUtc: row.resets_at_utc,
  }));
  const hours = Math.floor((nowUtc - observedAtUtc) / 3600);
  return makeQuotaSnapshot({
    agent,
    account,
    source: 'stored_history',
    observedAtUtc,
    windows,
    warnings: hours >= 1 ? [`stored reading is ${hours}h old (last good)`] : [],
  });
}
