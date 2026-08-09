import { Database } from 'bun:sqlite';

import { OPENCODE_BUSY_TIMEOUT_MS } from './constants.ts';

/**
 * Opens the live OpenCode database strictly read-only. The source is
 * canonical and owned by a running OpenCode process: no create, no
 * journal-mode changes, no immutable=1 (it would hide fresh WAL data).
 */
export function openOpenCodeSourceDatabase(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.exec(`PRAGMA busy_timeout = ${OPENCODE_BUSY_TIMEOUT_MS};`);
  return db;
}
