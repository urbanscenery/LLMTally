import { describe, expect, test } from 'bun:test';

import { PromptTracker } from '@llmtally/core/parsers/claude-code/prompts.ts';
import type { ClaudeUsageRecord, ClaudeUserRecord } from '@llmtally/core/parsers/claude-code/records.ts';

function userRecord(overrides: Partial<ClaudeUserRecord>): ClaudeUserRecord {
  return {
    kind: 'user',
    uuid: 'u1',
    parentUuid: null,
    isSidechain: false,
    promptText: 'main prompt',
    ...overrides,
  };
}

function usageRecord(overrides: Partial<ClaudeUsageRecord>): ClaudeUsageRecord {
  return {
    kind: 'usage',
    uuid: 'a1',
    parentUuid: 'u1',
    isSidechain: false,
    tsUtc: 1_785_578_405,
    model: 'claude-fable-5',
    effort: null,
    messageId: null,
    requestId: null,
    sessionId: null,
    cwd: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheWrite: 0,
    cacheRead: 0,
    ...overrides,
  };
}

describe('PromptTracker', () => {
  test('resolves main branch usage to the last eligible main prompt', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'first' }));
    tracker.recordUserPrompt(userRecord({ uuid: 'u2', promptText: 'second' }));

    // Act & Assert
    expect(tracker.resolvePrompt(usageRecord({}))).toBe('second');
  });

  test('keeps the prompt available for several assistant records', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'stays' }));

    // Act & Assert
    expect(tracker.resolvePrompt(usageRecord({ uuid: 'a1' }))).toBe('stays');
    expect(tracker.resolvePrompt(usageRecord({ uuid: 'a2' }))).toBe('stays');
  });

  test('correlates sidechain usage through the uuid chain without touching main', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));
    tracker.recordUserPrompt(
      userRecord({ uuid: 'su1', isSidechain: true, promptText: 'sidechain prompt' }),
    );

    // Act
    const first = tracker.resolvePrompt(
      usageRecord({ uuid: 'sa1', parentUuid: 'su1', isSidechain: true }),
    );
    const chained = tracker.resolvePrompt(
      usageRecord({ uuid: 'sa2', parentUuid: 'sa1', isSidechain: true }),
    );
    const main = tracker.resolvePrompt(usageRecord({ uuid: 'ma2' }));

    // Assert
    expect(first).toBe('sidechain prompt');
    expect(chained).toBe('sidechain prompt');
    expect(main).toBe('main prompt');
  });

  test('returns null for sidechain usage with an unknown or missing parent', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));

    // Act & Assert
    expect(
      tracker.resolvePrompt(usageRecord({ isSidechain: true, parentUuid: 'unknown' })),
    ).toBeNull();
    expect(tracker.resolvePrompt(usageRecord({ isSidechain: true, parentUuid: null }))).toBeNull();
  });

  test('round-trips pending prompts through cursor json', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'persisted' }));
    tracker.recordUserPrompt(
      userRecord({ uuid: 'su1', isSidechain: true, promptText: 'side persisted' }),
    );

    // Act
    const restored = PromptTracker.fromJson(tracker.toJson());

    // Assert
    expect(restored.resolvePrompt(usageRecord({}))).toBe('persisted');
    expect(
      restored.resolvePrompt(usageRecord({ isSidechain: true, parentUuid: 'su1' })),
    ).toBe('side persisted');
  });

  test('caps accumulated sidechain prompts while keeping the main prompt', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main survives' }));
    for (let index = 0; index < 400; index += 1) {
      tracker.recordUserPrompt(
        userRecord({ uuid: `su-${index}`, isSidechain: true, promptText: `side ${index}` }),
      );
    }

    // Act
    const serialized = tracker.toJson();

    // Assert — cursor json stays bounded and main is never evicted
    expect(Object.keys(serialized).length).toBeLessThanOrEqual(257);
    expect(tracker.resolvePrompt(usageRecord({}))).toBe('main survives');
    expect(
      tracker.resolvePrompt(usageRecord({ isSidechain: true, parentUuid: 'su-399' })),
    ).toBe('side 399');
  });

  test('ignores corrupt cursor json instead of failing the scan', () => {
    // Act
    const restored = PromptTracker.fromJson([1, 2, 3]);

    // Assert
    expect(restored.resolvePrompt(usageRecord({}))).toBeNull();
  });
});
