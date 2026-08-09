import { describe, expect, test } from 'bun:test';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import type { ScanBatch, SourceTarget } from '@llmtally/core/scan/types.ts';

describe('domain contracts', () => {
  test('LedgerEntry accepts a fully populated immutable record', () => {
    // Arrange
    const entry: LedgerEntry = {
      tsUtc: 1_786_350_000,
      agent: 'claude-code',
      account: null,
      provider: 'anthropic',
      model: 'claude-fable-5',
      effort: null,
      promptText: 'hello',
      inputTokens: 10,
      outputTokens: 20,
      cacheWrite: 0,
      cacheRead: 0,
      reasoningTokens: 0,
      costUsd: null,
      sessionId: 'session-1',
      cwd: '/tmp/project',
      naturalId: 'uuid-1',
      parserVersion: 1,
      isSidechain: false,
      parentUuid: null,
    };

    // Act & Assert
    expect(entry.agent).toBe('claude-code');
    expect(entry.costUsd).toBeNull();
  });

  test('ScanBatch carries entries, cursor, and tail flag together', () => {
    // Arrange
    const target: SourceTarget = {
      agent: 'claude-code',
      path: '/tmp/session.jsonl',
      kind: 'jsonl',
      fingerprint: null,
    };
    const batch: ScanBatch = {
      entries: [],
      nextOffset: 128,
      nextCursor: { version: 1 },
      sourceMtime: 0,
      sourceSize: 256,
      tailPending: true,
      warnings: [],
    };

    // Act & Assert
    expect(target.kind).toBe('jsonl');
    expect(batch.tailPending).toBe(true);
    expect(batch.nextOffset).toBe(128);
  });
});
