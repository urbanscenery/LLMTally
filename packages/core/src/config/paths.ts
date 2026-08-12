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
 * OpenCode's data directory, honoring `XDG_DATA_HOME` exactly like the
 * account module does. The parser and doctor used to hardcode
 * `~/.local/share` — on a Linux setup that moves XDG_DATA_HOME, they
 * silently collected nothing while the accounts tab saw the login
 * (grok cross-platform review P3).
 */
export function opencodeDataDir(home: string = homedir()): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.startsWith('/') ? xdg : join(home, '.local', 'share');
  return join(base, 'opencode');
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
