import type { Database } from 'bun:sqlite';

import initialSql from './migrations/001_initial.sql' with { type: 'text' };
import accountsSql from './migrations/002_accounts.sql' with { type: 'text' };
import quotaFetchStateSql from './migrations/003_quota_fetch_state.sql' with { type: 'text' };
import quotaSampleAccountIdSql from './migrations/004_quota_sample_account_id.sql' with { type: 'text' };
import quotaSampleIdentitySql from './migrations/005_quota_sample_identity.sql' with { type: 'text' };
import quotaAuthStateSql from './migrations/006_quota_auth_state.sql' with { type: 'text' };
import quotaSampleLatestIndexSql from './migrations/007_quota_sample_latest_index.sql' with { type: 'text' };
import claudeMessageDedupSql from './migrations/008_claude_message_dedup.sql' with { type: 'text' };
import promptKeySql from './migrations/009_prompt_key.sql' with { type: 'text' };
import quotaNoSubscriptionSql from './migrations/010_quota_no_subscription.sql' with { type: 'text' };

interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: '001_initial', sql: initialSql },
  { id: 2, name: '002_accounts', sql: accountsSql },
  { id: 3, name: '003_quota_fetch_state', sql: quotaFetchStateSql },
  { id: 4, name: '004_quota_sample_account_id', sql: quotaSampleAccountIdSql },
  { id: 5, name: '005_quota_sample_identity', sql: quotaSampleIdentitySql },
  { id: 6, name: '006_quota_auth_state', sql: quotaAuthStateSql },
  { id: 7, name: '007_quota_sample_latest_index', sql: quotaSampleLatestIndexSql },
  { id: 8, name: '008_claude_message_dedup', sql: claudeMessageDedupSql },
  { id: 9, name: '009_prompt_key', sql: promptKeySql },
  { id: 10, name: '010_quota_no_subscription', sql: quotaNoSubscriptionSql },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? 0;

/**
 * How many times to re-attempt `BEGIN IMMEDIATE` after the connection's
 * busy_timeout expires. A slow migration on a peer process (e.g. a full
 * table copy) can hold the write lock longer than one busy_timeout
 * window, so a lost race waits out several windows before it becomes a
 * hard error rather than failing the whole scan on first contention.
 */
const MIGRATION_LOCK_ATTEMPTS = 6;

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/** Applies pending migrations in order, each inside BEGIN IMMEDIATE / COMMIT. */
export function migrate(db: Database): void {
  for (const migration of MIGRATIONS) {
    // A cheap unlocked pre-check skips already-applied migrations without
    // taking a write lock; applyMigration re-checks under the lock so the
    // decision that actually mutates the schema is race-free.
    if (currentSchemaVersion(db) >= migration.id) {
      continue;
    }
    applyMigration(db, migration);
  }
}

export function currentSchemaVersion(db: Database): number {
  const metaTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    )
    .get();
  if (metaTable === null) {
    return 0;
  }
  const row = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  if (row === null) {
    return 0;
  }
  const version = Number.parseInt(row.value, 10);
  if (Number.isNaN(version)) {
    throw new MigrationError(`meta.schema_version is not a number: "${row.value}"`);
  }
  return version;
}

function applyMigration(db: Database, migration: Migration): void {
  // BEGIN IMMEDIATE takes the write lock up front (waiting out a peer via
  // busy_timeout), so the version we read next reflects whatever another
  // process already committed. Without this in-lock re-check two workers
  // that both passed the unlocked pre-check would each run the migration —
  // the loser hitting "duplicate column" and leaving meta split from the
  // real schema.
  beginImmediate(db, migration);
  try {
    if (currentSchemaVersion(db) >= migration.id) {
      db.exec('COMMIT;');
      return;
    }
    db.exec(migration.sql);
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      'schema_version',
      String(migration.id),
    ]);
    db.exec('COMMIT;');
  } catch (error) {
    // Guard the rollback: if the failure was the COMMIT itself there may
    // be no open transaction, and letting ROLLBACK throw would mask the
    // original cause.
    try {
      db.exec('ROLLBACK;');
    } catch {
      // nothing to unwind
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`migration ${migration.name} failed: ${cause}`);
  }
}

/**
 * Acquires the write lock, retrying on a busy database. busy_timeout is
 * an upper bound on one wait, not a success guarantee, so a peer holding
 * the lock past that window returns SQLITE_BUSY; only after several such
 * windows do we give up. Each retry re-reads the version inside the lock,
 * so a peer that finished in the meantime turns the retry into a no-op.
 */
function beginImmediate(db: Database, migration: Migration): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE;');
      return;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (attempt >= MIGRATION_LOCK_ATTEMPTS || !/lock|busy/i.test(cause)) {
        throw new MigrationError(
          `migration ${migration.name} could not acquire the write lock: ${cause}`,
        );
      }
    }
  }
}
