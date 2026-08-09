import { beforeEach, describe, expect, test } from 'bun:test';

import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { resetQuotaThrottle, throttledQuota } from '@llmtally/core/quota/throttle.ts';

const NOW = 1_786_400_000;

function good(usedPercent = 10, nowUtc = NOW): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'claude-code',
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [{ id: 'five_hour', usedPercent, resetsAtUtc: null }],
  });
}

function limited(retryAfterSeconds: number | null = null): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'claude-code',
    source: 'vendor_api',
    observedAtUtc: NOW,
    windows: [],
    rateLimited: true,
    retryAfterSeconds,
    warnings: ['claude usage endpoint returned 429 (rate limited)'],
  });
}

describe('quota throttle', () => {
  beforeEach(() => {
    resetQuotaThrottle();
  });

  test('a second read inside the window reuses the first reading', async () => {
    // Arrange
    let calls = 0;
    const fetchOnce = async (): Promise<QuotaSnapshot> => {
      calls += 1;
      return good(calls * 10);
    };

    // Act
    const first = await throttledQuota('claude-code', NOW, fetchOnce);
    const second = await throttledQuota('claude-code', NOW + 30, fetchOnce);

    // Assert
    expect(calls).toBe(1);
    expect(second.windows[0]?.usedPercent).toBe(first.windows[0]?.usedPercent);
  });

  test('the window expires so numbers do keep moving', async () => {
    // Arrange
    let calls = 0;
    const fetchOnce = async (): Promise<QuotaSnapshot> => {
      calls += 1;
      return good(calls * 10);
    };

    // Act
    await throttledQuota('claude-code', NOW, fetchOnce);
    const later = await throttledQuota('claude-code', NOW + 120, fetchOnce);

    // Assert
    expect(calls).toBe(2);
    expect(later.windows[0]?.usedPercent).toBe(20);
  });

  test('a 429 keeps the last good numbers and says when it will retry', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => good(42));

    // Act — the vendor refuses the next attempt
    const after = await throttledQuota('claude-code', NOW + 120, async () => limited());

    // Assert — data survives, with an explanation attached
    expect(after.windows[0]?.usedPercent).toBe(42);
    expect(after.warnings.join(' ')).toContain('rate limited; retrying in');
    expect(after.warnings.join(' ')).not.toContain('429');
  });

  test('the endpoint is not called again while backing off', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => limited());
    let calls = 0;

    // Act
    await throttledQuota('claude-code', NOW + 120, async () => {
      calls += 1;
      return good();
    });

    // Assert
    expect(calls).toBe(0);
  });

  test('backoff grows with repeated refusals', async () => {
    // Arrange — first refusal, wait it out, refuse again
    await throttledQuota('claude-code', NOW, async () => limited());
    const firstWait = 5 * 60;
    await throttledQuota('claude-code', NOW + firstWait + 1, async () => limited());

    // Act — halfway through the doubled window the endpoint is still off limits
    let calls = 0;
    await throttledQuota('claude-code', NOW + firstWait + 1 + 8 * 60, async () => {
      calls += 1;
      return good();
    });

    // Assert
    expect(calls).toBe(0);
  });

  test('a vendor retry-after longer than our backoff is honoured', async () => {
    // Act
    const snapshot = await throttledQuota('claude-code', NOW, async () => limited(3600));

    // Assert
    expect(snapshot.warnings.join(' ')).toContain('60m');
  });

  test('recovering clears the block for later reads', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => limited());

    // Act — after the window, a good reading resets everything
    await throttledQuota('claude-code', NOW + 6 * 60, async () => good(7));
    let calls = 0;
    const next = await throttledQuota('claude-code', NOW + 6 * 60 + 120, async () => {
      calls += 1;
      return good(9);
    });

    // Assert
    expect(calls).toBe(1);
    expect(next.windows[0]?.usedPercent).toBe(9);
  });

  test('keys are independent, so one vendor cannot block another', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => limited());
    let calls = 0;

    // Act
    await throttledQuota('codex', NOW + 1, async () => {
      calls += 1;
      return good();
    });

    // Assert
    expect(calls).toBe(1);
  });
});
