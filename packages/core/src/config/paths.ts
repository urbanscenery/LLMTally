import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything llmtally owns lives here: ledger, vault, config, cache. */
export function llmtallyHome(home: string = homedir()): string {
  return join(home, '.llmtally');
}

export function defaultDatabasePath(home: string = homedir()): string {
  return join(llmtallyHome(home), 'ledger.db');
}

/**
 * True when no ledger has been collected yet. A zero-byte file counts:
 * opening the database creates it before the first migration runs, so
 * an interrupted first launch leaves one behind.
 */
export function isFirstRun(databasePath: string): boolean {
  try {
    return !existsSync(databasePath) || statSync(databasePath).size === 0;
  } catch {
    return true;
  }
}
