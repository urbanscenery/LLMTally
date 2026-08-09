import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { escapePhraseQuery, FtsSyntaxError, searchPrompts } from '@llmtally/core/report/search.ts';
import { makeTempDir } from '../helpers.ts';

function seeded(): { path: string; db: ReturnType<typeof openDatabase> } {
  const path = join(makeTempDir(), 'ledger.db');
  const db = openDatabase(path);
  migrate(db);
  const insert = db.prepare(
    `INSERT INTO usage_ledger (ts_utc, agent, model, natural_id, parser_version, prompt_text)
     VALUES (?, ?, 'm', ?, 1, ?)`,
  );
  insert.run(1_786_000_000, 'claude-code', 'p1', 'refactor the parser module for speed');
  insert.run(1_786_100_000, 'codex', 'p2', 'write docs about the parser and caching');
  insert.run(1_786_200_000, 'claude-code', 'p3', 'unrelated question about lighthouse ranking');
  return { path, db };
}

function query(overrides: Record<string, unknown> = {}) {
  return {
    match: 'parser',
    rawSyntax: false,
    agent: null,
    range: { fromDate: null, toDate: null },
    limit: 20,
    fullPrompt: false,
    ...overrides,
  } as Parameters<typeof searchPrompts>[1];
}

describe('escapePhraseQuery', () => {
  test('wraps queries as literal phrases and doubles embedded quotes', () => {
    // Act & Assert
    expect(escapePhraseQuery('hello world')).toBe('"hello world"');
    expect(escapePhraseQuery('say "hi" AND drop')).toBe('"say ""hi"" AND drop"');
  });
});

describe('searchPrompts', () => {
  test('finds matching prompts with snippets and respects the agent filter', () => {
    // Arrange
    const { db } = seeded();

    // Act
    const all = searchPrompts(db, query());
    const codexOnly = searchPrompts(db, query({ agent: 'codex' }));

    // Assert
    expect(all).toHaveLength(2);
    expect(all[0]?.text).toContain('[parser]');
    expect(codexOnly).toHaveLength(1);
    expect(codexOnly[0]?.agent).toBe('codex');
    db.close();
  });

  test('operators inside a default query are matched literally, not executed', () => {
    // Arrange
    const { db } = seeded();

    // Act — as raw FTS this would OR-match nearly everything
    const literal = searchPrompts(db, query({ match: 'parser OR lighthouse' }));

    // Assert
    expect(literal).toHaveLength(0);
    db.close();
  });

  test('raw mode enables FTS grammar and reports syntax errors as usage errors', () => {
    // Arrange
    const { db } = seeded();

    // Act
    const or = searchPrompts(db, query({ match: 'parser OR lighthouse', rawSyntax: true }));

    // Assert
    expect(or).toHaveLength(3);
    expect(() => searchPrompts(db, query({ match: 'AND AND (', rawSyntax: true }))).toThrow(
      FtsSyntaxError,
    );
    db.close();
  });

  test('fullPrompt returns the entire prompt body', () => {
    // Arrange
    const { db } = seeded();

    // Act
    const hits = searchPrompts(db, query({ match: 'lighthouse', fullPrompt: true }));

    // Assert
    expect(hits[0]?.text).toBe('unrelated question about lighthouse ranking');
    db.close();
  });
});

