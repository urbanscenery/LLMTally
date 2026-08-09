import type { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { SqliteLedgerRepository } from '@llmtally/core/db/repository.ts';

/** Opens an isolated in-memory database with the full schema applied. */
export function createTestDb(): Database {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export function createTestRepository(): SqliteLedgerRepository {
  const repository = new SqliteLedgerRepository(openDatabase(':memory:'));
  repository.migrate();
  return repository;
}

export function fixturePath(...segments: readonly string[]): string {
  return join(import.meta.dir, 'fixtures', ...segments);
}

export function makeTempDir(prefix = 'llmtally-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
