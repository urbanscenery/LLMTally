import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { openDatabase } from '@llmtally/core/db/connection.ts';
import { SqliteLedgerRepository } from '@llmtally/core/db/repository.ts';
import type { CommitBatchInput, SourceTarget } from '@llmtally/core/scan/types.ts';

const target: SourceTarget = {
  agent: 'claude-code',
  path: '/tmp/session.jsonl',
  kind: 'jsonl',
  fingerprint: null,
};

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    tsUtc: 1_785_578_405,
    agent: 'claude-code',
    account: null,
    provider: 'anthropic',
    model: 'claude-fable-5',
    effort: 'high',
    promptText: 'searchable prompt body',
    inputTokens: 10,
    outputTokens: 20,
    cacheWrite: 5,
    cacheRead: 6,
    reasoningTokens: 0,
    costUsd: null,
    sessionId: 'sess-1',
    cwd: '/tmp/proj',
    naturalId: 'uuid-1',
    parserVersion: 1,
    isSidechain: false,
    parentUuid: null,
    ...overrides,
  };
}

function batchInput(entries: readonly LedgerEntry[], nextOffset: number | null = 512): CommitBatchInput {
  return {
    target,
    batch: {
      entries,
      nextOffset,
      nextCursor: { version: 1 },
      sourceMtime: 1_700_000_000_000,
      sourceSize: 2048,
      tailPending: false,
      warnings: [],
    },
  };
}

function setup(): { repository: SqliteLedgerRepository; db: Database } {
  const db = openDatabase(':memory:');
  const repository = new SqliteLedgerRepository(db);
  repository.migrate();
  return { repository, db };
}

describe('SqliteLedgerRepository.commitBatch', () => {
  test('inserts entries and advances the cursor in one commit', () => {
    // Arrange
    const { repository } = setup();

    // Act
    const result = repository.commitBatch(batchInput([entry({}), entry({ naturalId: 'uuid-2' })]));
    const state = repository.getScanState(target.agent, target.path);

    // Assert
    expect(result).toEqual({ insertedRows: 2, ignoredRows: 0, committedOffset: 512 });
    expect(state?.lastOffset).toBe(512);
    expect(state?.cursorJson).toEqual({ version: 1 });
    repository.close();
  });

  test('counts duplicate natural ids as ignored on rescan', () => {
    // Arrange
    const { repository } = setup();
    repository.commitBatch(batchInput([entry({})]));

    // Act
    const rescan = repository.commitBatch(batchInput([entry({}), entry({ naturalId: 'uuid-2' })]));

    // Assert
    expect(rescan).toEqual({ insertedRows: 1, ignoredRows: 1, committedOffset: 512 });
    repository.close();
  });

  test('refreshes token columns when a duplicate carries a larger output count', () => {
    // Arrange — Claude streams cumulative usage snapshots across the block
    // lines of one message; the last (largest) snapshot is what was billed
    const { repository, db } = setup();
    repository.commitBatch(batchInput([entry({ outputTokens: 7 })]));

    // Act
    const rescan = repository.commitBatch(
      batchInput([entry({ outputTokens: 250, cacheRead: 9, promptText: 'other prompt' })]),
    );
    const row = db
      .query<{ output_tokens: number; cache_read: number; prompt_text: string }, []>(
        'SELECT output_tokens, cache_read, prompt_text FROM usage_ledger',
      )
      .get();

    // Assert — tokens follow the larger snapshot, prompt_text stays put
    expect(rescan.insertedRows).toBe(1);
    expect(row?.output_tokens).toBe(250);
    expect(row?.cache_read).toBe(9);
    expect(row?.prompt_text).toBe('searchable prompt body');
    repository.close();
  });

  test('a token refresh cannot resurrect an aged prompt', () => {
    // Arrange
    const { repository, db } = setup();
    repository.commitBatch(batchInput([entry({ outputTokens: 7 })]));
    repository.agePrompts(1_785_578_405 + 1);

    // Act
    repository.commitBatch(batchInput([entry({ outputTokens: 250 })]));
    const row = db
      .query<{ output_tokens: number; prompt_text: string | null }, []>(
        'SELECT output_tokens, prompt_text FROM usage_ledger',
      )
      .get();

    // Assert
    expect(row?.output_tokens).toBe(250);
    expect(row?.prompt_text).toBeNull();
    repository.close();
  });

  test('makes committed prompts searchable through prompt_fts', () => {
    // Arrange
    const { repository, db } = setup();

    // Act
    repository.commitBatch(batchInput([entry({ promptText: 'find the hidden lighthouse' })]));
    const hit = db
      .query<{ rowid: number }, []>("SELECT rowid FROM prompt_fts WHERE prompt_fts MATCH 'lighthouse'")
      .get();

    // Assert
    expect(hit).not.toBeNull();
    repository.close();
  });

  test('rolls back both rows and cursor when any insert in the batch fails', () => {
    // Arrange
    const { repository, db } = setup();
    const poisoned = entry({ naturalId: 'uuid-3', tsUtc: {} as unknown as number });

    // Act & Assert
    expect(() => repository.commitBatch(batchInput([entry({}), poisoned]))).toThrow();
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage_ledger').get();
    expect(count?.n).toBe(0);
    expect(repository.getScanState(target.agent, target.path)).toBeNull();
    repository.close();
  });

  test('raises non-duplicate constraint violations instead of swallowing them', () => {
    // Arrange
    const { repository, db } = setup();
    const nullVersion = entry({ naturalId: 'uuid-4', parserVersion: null as unknown as number });

    // Act & Assert — DO NOTHING must only absorb natural-key duplicates
    expect(() => repository.commitBatch(batchInput([nullVersion]))).toThrow();
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage_ledger').get();
    expect(count?.n).toBe(0);
    repository.close();
  });

  test('leaves scan_state untouched when the batch has no committable offset', () => {
    // Arrange
    const { repository } = setup();

    // Act
    const result = repository.commitBatch(batchInput([], null));

    // Assert
    expect(result.committedOffset).toBeNull();
    expect(repository.getScanState(target.agent, target.path)).toBeNull();
    repository.close();
  });
});
