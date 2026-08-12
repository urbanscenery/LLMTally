import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

const BUSY_TIMEOUT_MS = 5000;
const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const MEMORY_PATH = ':memory:';
const WAL_SET_ATTEMPTS = 8;
const WAL_RETRY_BACKOFF_MS = 40;

export class DatabaseOpenError extends Error {
  override readonly name = 'DatabaseOpenError';
}

/**
 * Opens the ledger database with WAL, busy timeout, and private file
 * permissions. The ledger stores prompt bodies, so the containing
 * directory is forced to 0700 and the database file to 0600 — including
 * the -wal/-shm sidecars, which hold not-yet-checkpointed prompt text,
 * and pre-existing files created with looser modes.
 */
export function openDatabase(path: string): Database {
  const isMemory = path === MEMORY_PATH;
  if (!isMemory) {
    ensurePrivateDirectory(dirname(path));
    ensurePrivateFile(path);
    ensurePrivateFile(`${path}-wal`);
    ensurePrivateFile(`${path}-shm`);
  }

  const db = new Database(path, { create: true, strict: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  if (!isMemory) {
    enableWal(db, path);
  }
  assertFts5Available(db, path);
  return db;
}

/**
 * Switching a fresh rollback-journal file to WAL needs a brief exclusive
 * moment, and `PRAGMA journal_mode` does not always honor busy_timeout —
 * so when several processes open a brand-new ledger at once (first launch
 * with a scanner, TUI, and quota pollers racing), the transition can
 * either throw SQLITE_BUSY or, worse, silently return the unchanged mode
 * without throwing. Both are retried with a short backoff until the
 * PRAGMA actually reports `wal`; a caller must never proceed on a handle
 * that is still in rollback-journal mode.
 */
function enableWal(db: Database, path: string): void {
  for (let attempt = 1; ; attempt += 1) {
    let mode: string | null = null;
    try {
      const row = db
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL;')
        .get();
      mode = row?.journal_mode ?? null;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (attempt >= WAL_SET_ATTEMPTS || !/lock|busy/i.test(cause)) {
        db.close();
        throw new DatabaseOpenError(`could not enable WAL mode on ${path}: ${cause}`);
      }
      Bun.sleepSync(WAL_RETRY_BACKOFF_MS * attempt);
      continue;
    }
    if (mode?.toLowerCase() === 'wal') {
      return;
    }
    // the PRAGMA returned the old mode without throwing (a peer held a
    // lock during the transition): retry rather than accept a non-WAL
    // handle, whose rollback journal would defeat the concurrent access
    if (attempt >= WAL_SET_ATTEMPTS) {
      db.close();
      throw new DatabaseOpenError(
        `could not enable WAL mode on ${path}: still ${mode ?? 'unknown'} after ${attempt} attempts`,
      );
    }
    Bun.sleepSync(WAL_RETRY_BACKOFF_MS * attempt);
  }
}

export class LedgerUnavailableError extends Error {
  override readonly name = 'LedgerUnavailableError';

  constructor(path: string, detail: string) {
    super(`ledger at ${path} ${detail}; it is collected on first launch`);
  }
}

/**
 * Read-only ledger access for report/query paths: no directory creation,
 * no chmod, no migrations, no scan lock. A missing or outdated ledger is
 * an explicit error instead of silently creating an empty database.
 */
export function openReadOnlyDatabase(path: string, expectedSchemaVersion: number): Database {
  let db: Database;
  try {
    db = new Database(path, { readonly: true, strict: true });
  } catch (error) {
    throw new LedgerUnavailableError(
      path,
      `cannot be opened (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec('PRAGMA query_only = ON;');
  let row: { value: string } | null;
  try {
    row = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
  } catch {
    db.close();
    throw new LedgerUnavailableError(path, 'is not an llmtally ledger (no meta table)');
  }
  const version = row !== null && /^\d+$/.test(row.value) ? Number(row.value) : null;
  if (version !== expectedSchemaVersion) {
    db.close();
    throw new LedgerUnavailableError(
      path,
      `has schema version ${version ?? 'none'} (expected ${expectedSchemaVersion})`,
    );
  }
  return db;
}

/**
 * Creates the directory privately when we create it, but never forces a
 * mode onto one that already exists: a ledger can legitimately live in
 * a shared or system directory we do not own, and failing the whole
 * scan over its permissions is worse than the file mode we do enforce.
 * doctor reports a loose directory so it is still visible.
 */
function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  try {
    chmodSync(directory, DIRECTORY_MODE);
  } catch {
    // not ours to tighten; the 0600 database file still protects prompts
  }
}

function ensurePrivateFile(path: string): void {
  closeSync(openSync(path, 'a', DATABASE_MODE));
  chmodSync(path, DATABASE_MODE);
}

function assertFts5Available(db: Database, path: string): void {
  const row = db
    .query<{ name: string }, []>("SELECT name FROM pragma_module_list WHERE name = 'fts5'")
    .get();
  if (row === null) {
    db.close();
    throw new DatabaseOpenError(
      `SQLite at ${path} lacks FTS5 support; llmtally requires an FTS5-enabled build`,
    );
  }
}
