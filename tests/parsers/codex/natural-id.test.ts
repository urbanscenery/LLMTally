import { describe, expect, test } from 'bun:test';

import { buildCodexNaturalId, usageDigest } from '@llmtally/core/parsers/codex/natural-id.ts';
import type { CodexTokenUsage } from '@llmtally/core/parsers/codex/records.ts';

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

describe('usageDigest', () => {
  test('is deterministic for identical usage snapshots', () => {
    // Act & Assert
    expect(usageDigest(usage(), usage({ totalTokens: 500 }))).toBe(
      usageDigest(usage(), usage({ totalTokens: 500 })),
    );
  });

  test('differs when any token field changes', () => {
    // Arrange
    const total = usage({ totalTokens: 500 });

    // Act & Assert
    expect(usageDigest(usage(), total)).not.toBe(usageDigest(usage({ outputTokens: 21 }), total));
    expect(usageDigest(usage(), total)).not.toBe(
      usageDigest(usage(), usage({ totalTokens: 501 })),
    );
  });
});

describe('buildCodexNaturalId', () => {
  test('keys turn-bound usage by turn id plus content digest', () => {
    // Arrange
    const digest = usageDigest(usage(), usage({ totalTokens: 500 }));

    // Act & Assert
    expect(
      buildCodexNaturalId({
        turnId: 'turn-1',
        usageDigest: digest,
        rolloutId: 'rollout-1',
        lineStartOffset: 512,
      }),
    ).toBe(`turn:turn-1:usage:${digest}`);
  });

  test('a replayed identical event dedupes while distinct usage in a resumed turn survives', () => {
    // Arrange — the same turn_id reappears after a resume; counters reset
    // but the cumulative totals differ, so the keys must differ
    const original = buildCodexNaturalId({
      turnId: 'turn-9',
      usageDigest: usageDigest(usage(), usage({ totalTokens: 500 })),
      rolloutId: 'rollout-parent',
      lineStartOffset: 100,
    });
    const replayed = buildCodexNaturalId({
      turnId: 'turn-9',
      usageDigest: usageDigest(usage(), usage({ totalTokens: 500 })),
      rolloutId: 'rollout-child',
      lineStartOffset: 9_999,
    });
    const resumedDistinct = buildCodexNaturalId({
      turnId: 'turn-9',
      usageDigest: usageDigest(usage({ outputTokens: 77 }), usage({ totalTokens: 900 })),
      rolloutId: 'rollout-parent',
      lineStartOffset: 8_888,
    });

    // Act & Assert
    expect(replayed).toBe(original);
    expect(resumedDistinct).not.toBe(original);
  });

  test('falls back to rollout identity plus byte offset for turnless usage', () => {
    // Act & Assert
    expect(
      buildCodexNaturalId({
        turnId: null,
        usageDigest: null,
        rolloutId: 'rollout-1',
        lineStartOffset: 512,
      }),
    ).toBe('rollout:rollout-1:offset:512');
  });

  test('returns null when neither identity exists', () => {
    // Act & Assert
    expect(
      buildCodexNaturalId({
        turnId: null,
        usageDigest: null,
        rolloutId: null,
        lineStartOffset: 512,
      }),
    ).toBeNull();
  });
});
