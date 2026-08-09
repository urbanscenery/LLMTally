import { describe, expect, test } from 'bun:test';

import {
  isSourceAuthoritative,
  minTierThreshold,
  nominalUsdFor,
  selectTierRates,
} from '@llmtally/core/pricing/calculator.ts';
import type { PriceRates, PriceRecord, TokenTotals } from '@llmtally/core/pricing/types.ts';

const rates: PriceRates = {
  inputUsdPerToken: 1e-5,
  outputUsdPerToken: 5e-5,
  cacheReadUsdPerToken: 1e-6,
  cacheWriteUsdPerToken: 1.25e-5,
};

function tokens(overrides: Partial<TokenTotals> = {}): TokenTotals {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    cacheWrite: 100,
    cacheRead: 5000,
    reasoningTokens: 50,
    ...overrides,
  };
}

describe('nominalUsdFor', () => {
  test('claude prices all four dimensions and never re-prices reasoning', () => {
    // Act
    const outcome = nominalUsdFor('claude-code', tokens(), rates);

    // Assert — 1000*1e-5 + 200*5e-5 + 5000*1e-6 + 100*1.25e-5
    expect(outcome).toEqual({ ok: true, usd: 0.01 + 0.01 + 0.005 + 0.00125 });
  });

  test('codex subtracts cached input from the base input tokens', () => {
    // Act
    const outcome = nominalUsdFor('codex', tokens({ inputTokens: 6000 }), rates);

    // Assert — (6000-5000)*1e-5 + 200*5e-5 + 5000*1e-6 + 100*1.25e-5
    expect(outcome).toEqual({ ok: true, usd: 0.01 + 0.01 + 0.005 + 0.00125 });
  });

  test('codex input smaller than cache read refuses instead of clamping', () => {
    // Act & Assert
    expect(nominalUsdFor('codex', tokens({ inputTokens: 100 }), rates)).toEqual({
      ok: false,
      code: 'invalid_token_semantics',
    });
  });

  test('consumed cache dimensions with missing rates refuse to price', () => {
    // Arrange
    const noCacheRead = { ...rates, cacheReadUsdPerToken: null };
    const noCacheWrite = { ...rates, cacheWriteUsdPerToken: null };

    // Act & Assert
    expect(nominalUsdFor('claude-code', tokens(), noCacheRead)).toEqual({
      ok: false,
      code: 'missing_cache_read_rate',
    });
    expect(nominalUsdFor('claude-code', tokens(), noCacheWrite)).toEqual({
      ok: false,
      code: 'missing_cache_write_rate',
    });
    expect(
      nominalUsdFor('claude-code', tokens({ cacheWrite: 0, cacheRead: 0 }), noCacheWrite),
    ).toMatchObject({ ok: true });
  });

  test('source-authoritative and unknown agents are never nominally priced', () => {
    // Act & Assert
    expect(nominalUsdFor('opencode', tokens(), rates)).toEqual({ ok: false, code: 'price_not_found' });
    expect(nominalUsdFor('someday-agent', tokens(), rates)).toEqual({ ok: false, code: 'price_not_found' });
    expect(isSourceAuthoritative('opencode')).toBe(true);
    expect(isSourceAuthoritative('codex')).toBe(false);
  });
});

describe('tier selection', () => {
  const tiered: PriceRecord = {
    key: 't',
    source: 'litellm',
    sourceModel: 't',
    fetchedAtUtc: 0,
    ...rates,
    tiers: [
      { aboveInputTokens: 128_000, rates: { ...rates, inputUsdPerToken: 2e-5 } },
      { aboveInputTokens: 272_000, rates: { ...rates, inputUsdPerToken: 3e-5 } },
    ],
  };

  test('selects the highest tier strictly below the input size', () => {
    // Act & Assert — boundaries are strict greater-than
    expect(selectTierRates(tiered, 128_000).inputUsdPerToken).toBe(1e-5);
    expect(selectTierRates(tiered, 128_001).inputUsdPerToken).toBe(2e-5);
    expect(selectTierRates(tiered, 500_000).inputUsdPerToken).toBe(3e-5);
  });

  test('reports the minimum tier threshold for fallback detection', () => {
    // Act & Assert
    expect(minTierThreshold(tiered)).toBe(128_000);
    expect(minTierThreshold({ ...tiered, tiers: [] })).toBeNull();
  });
});
