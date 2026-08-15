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

  test('a re-emitted turn_context for the same turn keeps its prompt and counters', () => {
    // Arrange — codex writes turn_context again after a compaction
    const tracker = new CodexTurnTracker();
    tracker.startTurn(turnContext('turn-1'));
    tracker.recordUserPrompt('long task');
    tracker.acceptUsage(tokenCount(usage()));

    // Act
    tracker.startTurn({ ...turnContext('turn-1'), model: 'gpt-5.6-sol', effort: 'medium' });
    const decision = tracker.acceptUsage(tokenCount(usage({ totalTokens: 400 })));

    // Assert — prompt survives, ordinal continues, model refreshed
    expect(decision).toMatchObject({
      kind: 'accepted',
      ordinal: 2,
      turn: { turnId: 'turn-1', promptText: 'long task', model: 'gpt-5.6-sol', effort: 'medium' },
    });
  });

  test('a prompt pending across a same-turn re-emit still waits for the next turn', () => {
    // Arrange
    const tracker = new CodexTurnTracker();
    tracker.startTurn(turnContext('turn-1'));
    tracker.recordUserPrompt('first');
    tracker.acceptUsage(tokenCount(usage()));
    tracker.recordUserPrompt('queued for later');
    tracker.startTurn(turnContext('turn-1'));

    // Act
    const sameTurn = tracker.acceptUsage(tokenCount(usage({ totalTokens: 400 })));
    tracker.startTurn(turnContext('turn-2'));
    const nextTurn = tracker.acceptUsage(tokenCount(usage({ totalTokens: 500 })));

    // Assert
    expect(sameTurn).toMatchObject({ kind: 'accepted', turn: { promptText: 'first' } });
    expect(nextTurn).toMatchObject({ kind: 'accepted', turn: { turnId: 'turn-2', promptText: 'queued for later' } });
  });

  test('several prompts before the first usage are kept together, not overwritten', () => {
    // Arrange
    const tracker = new CodexTurnTracker();
    tracker.startTurn(turnContext('turn-1'));
    tracker.recordUserPrompt('do the thing');
    tracker.recordUserPrompt('and also this');
    tracker.recordUserPrompt('and also this');

    // Act & Assert — identical repeats collapse, distinct ones stack
    expect(tracker.acceptUsage(tokenCount(usage()))).toMatchObject({
      kind: 'accepted',
      turn: { promptText: 'do the thing\nand also this' },
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
