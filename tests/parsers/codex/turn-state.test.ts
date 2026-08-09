import { describe, expect, test } from 'bun:test';

import type {
  CodexTokenCountRecord,
  CodexTokenUsage,
  CodexTurnContextRecord,
} from '@llmtally/core/parsers/codex/records.ts';
import { CodexTurnTracker } from '@llmtally/core/parsers/codex/turn-state.ts';

function usage(overrides: Partial<CodexTokenUsage> = {}): CodexTokenUsage {
  return {
    inputTokens: 100,
    cachedInputTokens: 50,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    ...overrides,
  };
}

function tokenCount(total: CodexTokenUsage, last: CodexTokenUsage = total): CodexTokenCountRecord {
  return { kind: 'token_count', tsUtc: 1_786_348_217, last, total };
}

function turnContext(turnId: string): CodexTurnContextRecord {
  return { kind: 'turn_context', turnId, model: 'gpt-5.5', effort: 'xhigh', cwd: '/tmp/proj' };
}

describe('CodexTurnTracker', () => {
  test('binds a prompt seen before turn_context to the new turn', () => {
    // Arrange
    const tracker = new CodexTurnTracker();
    tracker.recordUserPrompt('early prompt');
    tracker.startTurn(turnContext('turn-1'));

    // Act
    const decision = tracker.acceptUsage(tokenCount(usage()));

    // Assert
    expect(decision).toMatchObject({
      kind: 'accepted',
      ordinal: 1,
      turn: { turnId: 'turn-1', promptText: 'early prompt', model: 'gpt-5.5', effort: 'xhigh' },
    });
  });

  test('binds a prompt seen after turn_context but before usage', () => {
    // Arrange
    const tracker = new CodexTurnTracker();
    tracker.startTurn(turnContext('turn-1'));
    tracker.recordUserPrompt('late prompt');

    // Act & Assert
    expect(tracker.acceptUsage(tokenCount(usage()))).toMatchObject({
      kind: 'accepted',
      turn: { promptText: 'late prompt' },
    });
  });

  test('a prompt after usage waits for the next turn instead of rebinding', () => {
    // Arrange
    const tracker = new CodexTurnTracker();
    tracker.startTurn(turnContext('turn-1'));
    tracker.recordUserPrompt('first');
    tracker.acceptUsage(tokenCount(usage()));
    tracker.recordUserPrompt('second');
    tracker.startTurn(turnContext('turn-2'));

    // Act & Assert
    expect(tracker.acceptUsage(tokenCount(usage({ totalTokens: 300 })))).toMatchObject({
      kind: 'accepted',
      ordinal: 1,
      turn: { turnId: 'turn-2', promptText: 'second' },
    });
  });

  test('skips duplicate cumulative total snapshots without advancing the ordinal', () => {
    // Arrange
    const tracker = new CodexTurnTracker();
    tracker.startTurn(turnContext('turn-1'));
    const snapshot = tokenCount(usage());

    // Act
    const first = tracker.acceptUsage(snapshot);
    const duplicate = tracker.acceptUsage(snapshot);
    const changed = tracker.acceptUsage(tokenCount(usage({ totalTokens: 500 })));

    // Assert
    expect(first).toMatchObject({ kind: 'accepted', ordinal: 1 });
    expect(duplicate).toEqual({ kind: 'duplicate' });
    expect(changed).toMatchObject({ kind: 'accepted', ordinal: 2 });
  });

  test('reports usage without any turn context as no_turn', () => {
    // Arrange
    const tracker = new CodexTurnTracker();

    // Act & Assert
    expect(tracker.acceptUsage(tokenCount(usage()))).toEqual({ kind: 'no_turn' });
  });

  test('round-trips its state through cursor json', () => {
    // Arrange
    const tracker = new CodexTurnTracker();
    tracker.startTurn(turnContext('turn-1'));
    tracker.recordUserPrompt('persisted prompt');
    tracker.acceptUsage(tokenCount(usage()));
    const serialized = tracker.toJson();

    // Act
    const restored = CodexTurnTracker.fromJson(serialized.pendingPrompt, serialized.activeTurn);
    const duplicate = restored.acceptUsage(tokenCount(usage()));
    const changed = restored.acceptUsage(tokenCount(usage({ totalTokens: 999 })));

    // Assert — duplicate detection and ordinal continue across the restore
    expect(duplicate).toEqual({ kind: 'duplicate' });
    expect(changed).toMatchObject({ kind: 'accepted', ordinal: 2 });
  });

  test('ignores corrupt persisted turn state instead of crashing', () => {
    // Act
    const restored = CodexTurnTracker.fromJson(42, { turnId: 'x' });

    // Assert
    expect(restored.acceptUsage(tokenCount(usage()))).toEqual({ kind: 'no_turn' });
  });
});
