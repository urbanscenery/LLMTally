import type { Database } from 'bun:sqlite';

import initialSql from './migrations/001_initial.sql' with { type: 'text' };
import accountsSql from './migrations/002_accounts.sql' with { type: 'text' };

interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: '001_initial', sql: initialSql },
  { id: 2, name: '002_accounts', sql: accountsSql },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? 0;

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/** Applies pending migrations in order, each inside BEGIN IMMEDIATE / COMMIT. */
export function migrate(db: Database): void {
  for (const migration of MIGRATIONS) {
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
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(migration.sql);
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      'schema_version',
      String(migration.id),
    ]);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`migration ${migration.name} failed: ${cause}`);
  }
}
