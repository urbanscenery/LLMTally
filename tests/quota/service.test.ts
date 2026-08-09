import { describe, expect, test } from 'bun:test';

import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { dedupeByAccount } from '@llmtally/core/quota/service.ts';

const NOW = 1_786_400_000;

function snapshot(overrides: Partial<QuotaSnapshot> & { agent: string }): QuotaSnapshot {
  return makeQuotaSnapshot({
    source: 'vendor_api',
    observedAtUtc: NOW,
    windows: [{ id: 'five_hour', usedPercent: 10, resetsAtUtc: null }],
    ...overrides,
  });
}

describe('dedupeByAccount', () => {
  test('the freshest reading wins when one account has several sources', () => {
    // Arrange — live now vs a 5h-old third-party cache for the same account
    const live = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'vendor_api',
      observedAtUtc: NOW,
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 18_000,
      warnings: ['cached reading is 5h old (not live)'],
    });

    // Act
    const result = dedupeByAccount([live, cached]);

    // Assert — one row, live kept, the stale row's own staleness note dropped
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('vendor_api');
    expect(result[0]?.warnings).toHaveLength(0);
  });

  test('a cache fresher than our stored sample wins over source rank', () => {
    // Arrange
    const stored = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'stored_history',
      observedAtUtc: NOW - 10_800,
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 60,
    });

    // Act & Assert
    expect(dedupeByAccount([stored, cached])[0]?.source).toBe('third_party_cache');
  });

  test('a failed reading contributes its warning to the surviving row', () => {
    // Arrange — the live call failed (no windows) but explains why
    const failed = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'vendor_api',
      windows: [],
      warnings: ['claude quota fetch failed: http 429'],
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 600,
    });

    // Act
    const result = dedupeByAccount([failed, cached]);

    // Assert — data from the cache, the failure reason preserved
    expect(result).toHaveLength(1);
    expect(result[0]?.windows).toHaveLength(1);
    expect(result[0]?.warnings).toEqual(['claude quota fetch failed: http 429']);
  });

  test('the surviving row keeps the position of its first appearance', () => {
    // Arrange
    const codex = snapshot({ agent: 'codex', account: 'c@test.dev' });
    const claudeStale = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 3600,
    });
    const claudeLive = snapshot({ agent: 'claude-code', account: 'me@test.dev' });

    // Act
    const result = dedupeByAccount([claudeStale, codex, claudeLive]);

    // Assert
    expect(result.map((entry) => entry.agent)).toEqual(['claude-code', 'codex']);
    expect(result[0]?.source).toBe('vendor_api');
  });

  test('different accounts and unlabeled rows are never merged', () => {
    // Arrange
    const first = snapshot({ agent: 'claude-code', account: 'a@test.dev' });
    const second = snapshot({ agent: 'claude-code', account: 'b@test.dev' });
    const unlabeledA = snapshot({ agent: 'codex', account: null });
    const unlabeledB = snapshot({ agent: 'codex', account: null });

    // Act & Assert
    expect(dedupeByAccount([first, second, unlabeledA, unlabeledB])).toHaveLength(4);
  });

  test('an alias-labeled row stays separate from the plain email row', () => {
    // Arrange — labels differ, so these are treated as distinct rows
    const plain = snapshot({ agent: 'claude-code', account: 'me@test.dev' });
    const aliased = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev [work]',
      source: 'third_party_cache',
    });

    // Act & Assert
    expect(dedupeByAccount([plain, aliased])).toHaveLength(2);
  });
});

// loadAllQuota itself is not unit-tested here: it composes live network
// sources and the machine's real agent stores, so any assertion about it
// would depend on the environment. Its parts are covered individually
// (providers, vault-accounts, antigravity, codex-live) and by the rules above.
