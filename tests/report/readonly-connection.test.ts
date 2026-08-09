import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LedgerUnavailableError,
  openDatabase,
  openReadOnlyDatabase,
} from '@llmtally/core/db/connection.ts';
import { LATEST_SCHEMA_VERSION, migrate } from '@llmtally/core/db/migrate.ts';
import { makeTempDir } from '../helpers.ts';

function createLedger(): string {
  const path = join(makeTempDir(), 'ledger.db');
  const db = openDatabase(path);
  migrate(db);
  db.close();
  return path;
}

describe('openReadOnlyDatabase', () => {
  test('opens a migrated ledger and can query it', () => {
    // Arrange
    const path = createLedger();

    // Act
    const db = openReadOnlyDatabase(path, LATEST_SCHEMA_VERSION);

    // Assert
    expect(db.query('SELECT COUNT(*) AS n FROM usage_ledger').get()).toEqual({ n: 0 });
    db.close();
  });

  test('rejects writes through the read-only connection', () => {
    // Arrange
    const path = createLedger();
    const db = openReadOnlyDatabase(path, LATEST_SCHEMA_VERSION);

    // Act & Assert
    expect(() => db.run("INSERT INTO meta (key, value) VALUES ('x', 'y')")).toThrow();
    db.close();
  });

  test('throws LedgerUnavailableError for a missing database without creating it', () => {
    // Arrange
    const path = join(makeTempDir(), 'none.db');

    // Act & Assert
    expect(() => openReadOnlyDatabase(path, LATEST_SCHEMA_VERSION)).toThrow(
      LedgerUnavailableError,
    );
    expect(() => statSync(path)).toThrow();
  });

  test('throws for a database that is not an llmtally ledger', () => {
    // Arrange
    const path = join(makeTempDir(), 'foreign.db');
    const db = new Database(path, { create: true });
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();

    // Act & Assert
    expect(() => openReadOnlyDatabase(path, LATEST_SCHEMA_VERSION)).toThrow(/no meta table/);
  });

  test('throws on a schema version mismatch', () => {
    // Arrange
    const path = createLedger();

    // Act & Assert
    expect(() => openReadOnlyDatabase(path, LATEST_SCHEMA_VERSION + 1)).toThrow(
      /schema version/,
    );
  });

  test('does not alter the ledger file mode or mtime', () => {
    // Arrange
    const path = createLedger();
    const before = statSync(path);

    // Act
    const db = openReadOnlyDatabase(path, LATEST_SCHEMA_VERSION);
    db.query('SELECT 1').get();
    db.close();

    // Assert
    const after = statSync(path);
    expect(after.mode).toBe(before.mode);
    expect(after.size).toBe(before.size);
  });

  test('rejects a corrupt file with a clear error', () => {
    // Arrange
    const path = join(makeTempDir(), 'corrupt.db');
    writeFileSync(path, 'this is not sqlite');

    // Act & Assert
    expect(() => openReadOnlyDatabase(path, LATEST_SCHEMA_VERSION)).toThrow(
      LedgerUnavailableError,
    );
  });
});
