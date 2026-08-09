import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import initialSql from '@llmtally/core/db/migrations/001_initial.sql' with { type: 'text' };

function createEmptyDb(): Database {
  const db = new Database(':memory:', { strict: true });
  db.exec(initialSql);
  return db;
}

function tableNames(db: Database): readonly string[] {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}

describe('001_initial migration', () => {
  test('creates ledger, state, meta, fts tables and triggers on an empty db', () => {
    // Arrange & Act
    const db = createEmptyDb();
    const names = tableNames(db);

    // Assert
    expect(names).toContain('usage_ledger');
    expect(names).toContain('scan_state');
    expect(names).toContain('meta');
    expect(names).toContain('prompt_fts');
    expect(names).toContain('usage_ledger_ai');
    expect(names).toContain('usage_ledger_ad');
    expect(names).toContain('usage_ledger_au');
    db.close();
  });

  test('is idempotent when applied twice', () => {
    // Arrange
    const db = createEmptyDb();

    // Act
    db.exec(initialSql);
    const version = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();

    // Assert
    expect(version?.value).toBe('1');
    db.close();
  });

  test('insert trigger keeps prompt_fts searchable via MATCH', () => {
    // Arrange
    const db = createEmptyDb();
    db.run(
      `INSERT INTO usage_ledger
         (ts_utc, agent, model, natural_id, parser_version, prompt_text)
       VALUES (1786350000, 'claude-code', 'claude-fable-5', 'uuid-1', 1, 'find the treasure map')`,
    );

    // Act
    const hit = db
      .query<{ rowid: number }, []>("SELECT rowid FROM prompt_fts WHERE prompt_fts MATCH 'treasure'")
      .get();
    const ledger = db
      .query<{ id: number }, []>("SELECT id FROM usage_ledger WHERE natural_id = 'uuid-1'")
      .get();

    // Assert
    expect(hit).not.toBeNull();
    expect(hit?.rowid).toBe(ledger?.id ?? -1);
    db.close();
  });

  test('delete trigger removes rows from the fts index', () => {
    // Arrange
    const db = createEmptyDb();
    db.run(
      `INSERT INTO usage_ledger
         (ts_utc, agent, model, natural_id, parser_version, prompt_text)
       VALUES (1786350000, 'claude-code', 'claude-fable-5', 'uuid-2', 1, 'ephemeral entry')`,
    );

    // Act
    db.run("DELETE FROM usage_ledger WHERE natural_id = 'uuid-2'");
    const hit = db
      .query<{ rowid: number }, []>("SELECT rowid FROM prompt_fts WHERE prompt_fts MATCH 'ephemeral'")
      .get();

    // Assert
    expect(hit).toBeNull();
    db.close();
  });

  test('rejects duplicate natural ids per agent and non-boolean sidechain flags', () => {
    // Arrange
    const db = createEmptyDb();
    const insert = `INSERT INTO usage_ledger
        (ts_utc, agent, model, natural_id, parser_version)
      VALUES (1786350000, 'claude-code', 'claude-fable-5', 'dup-1', 1)`;
    db.run(insert);

    // Act & Assert
    expect(() => db.run(insert)).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO usage_ledger
           (ts_utc, agent, model, natural_id, parser_version, is_sidechain)
         VALUES (1786350000, 'claude-code', 'claude-fable-5', 'chk-1', 1, 2)`,
      ),
    ).toThrow();
    db.close();
  });
});
