import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixturePath, makeTempDir } from './helpers.ts';

/**
 * Builds a throwaway OpenCode source database from SQL scripts so no
 * binary fixture lives in the repository.
 */
export function createOpenCodeFixtureDb(...sqlFiles: readonly string[]): string {
  const path = join(makeTempDir(), 'opencode.db');
  applyOpenCodeSql(path, 'schema.sql', ...sqlFiles);
  return path;
}

export function applyOpenCodeSql(databasePath: string, ...sqlFiles: readonly string[]): void {
  const db = new Database(databasePath, { create: true, strict: true });
  try {
    for (const file of sqlFiles) {
      db.exec(readFileSync(fixturePath('opencode', file), 'utf8'));
    }
  } finally {
    db.close();
  }
}
