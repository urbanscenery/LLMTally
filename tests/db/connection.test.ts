import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { LATEST_SCHEMA_VERSION, currentSchemaVersion, migrate } from '@llmtally/core/db/migrate.ts';
import { SqliteLedgerRepository } from '@llmtally/core/db/repository.ts';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llmtally-test-'));
  return join(dir, 'nested', 'ledger.db');
}

describe('openDatabase', () => {
  test('opens an in-memory database with fts5 available', () => {
    // Arrange & Act
    const db = openDatabase(':memory:');

    // Assert
    expect(db.query('SELECT 1 AS one').get()).toEqual({ one: 1 });
    db.close();
  });

  test('creates the parent directory as 0700 and the db file as 0600 in WAL mode', () => {
    // Arrange
    const path = tempDbPath();

    // Act
    const db = openDatabase(path);
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();

    // Assert
    expect(mode?.journal_mode).toBe('wal');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    db.close();
  });

  test('protects the wal and shm sidecars, which carry prompt text, as 0600', () => {
    // Arrange
    const path = tempDbPath();

    // Act
    const db = openDatabase(path);
    db.exec('CREATE TABLE t (v TEXT)');
    db.run("INSERT INTO t VALUES ('uncommitted prompt body')");

    // Assert
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
    db.close();
  });

  test('tightens permissions of a pre-existing loose db file and directory', () => {
    // Arrange
    const path = tempDbPath();
    const { mkdirSync, writeFileSync, chmodSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o755 });
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    chmodSync(join(path, '..'), 0o755);

    // Act
    const db = openDatabase(path);

    // Assert
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    db.close();
  });
});

describe('migrate runner', () => {
  test('applies pending migrations and records the schema version', () => {
    // Arrange
    const db = openDatabase(':memory:');
    expect(currentSchemaVersion(db)).toBe(0);

    // Act
    migrate(db);

    // Assert
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  test('re-running migrate leaves the schema version unchanged', () => {
    // Arrange
    const db = openDatabase(':memory:');
    migrate(db);

    // Act
    migrate(db);

    // Assert
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});

describe('SqliteLedgerRepository scan state', () => {
  test('returns null for an unknown source path', () => {
    // Arrange
    const repository = new SqliteLedgerRepository(openDatabase(':memory:'));
    repository.migrate();

    // Act
    const state = repository.getScanState('claude-code', '/nowhere.jsonl');

    // Assert
    expect(state).toBeNull();
    repository.close();
  });

  test('round-trips a stored scan state row with parsed cursor json', () => {
    // Arrange
    const db = openDatabase(':memory:');
    const repository = new SqliteLedgerRepository(db);
    repository.migrate();
    db.run(
      `INSERT INTO scan_state (agent, path, mtime, size, last_offset, cursor_json)
       VALUES ('claude-code', '/a.jsonl', 1700000000000, 2048, 1024, '{"version":1}')`,
    );

    // Act
    const state = repository.getScanState('claude-code', '/a.jsonl');

    // Assert
    expect(state).toEqual({
      agent: 'claude-code',
      path: '/a.jsonl',
      mtime: 1700000000000,
      size: 2048,
      lastOffset: 1024,
      cursorJson: { version: 1 },
    });
    repository.close();
  });
});
