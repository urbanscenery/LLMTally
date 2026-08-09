import { describe, expect, test } from 'bun:test';

import { parseLiteLlmPayload } from '@llmtally/core/pricing/litellm.ts';
import { parseOpenRouterPayload } from '@llmtally/core/pricing/openrouter.ts';

const FETCHED_AT = 1_786_400_000;

describe('parseLiteLlmPayload', () => {
  test('parses full rate sets including nullable cache rates', () => {
    // Arrange
    const payload = {
      'claude-fable-5': {
        input_cost_per_token: 1e-5,
        output_cost_per_token: 5e-5,
        cache_read_input_token_cost: 1e-6,
        cache_creation_input_token_cost: 1.25e-5,
        litellm_provider: 'anthropic',
      },
      'gpt-5.5': { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5, cache_read_input_token_cost: 5e-7 },
    };

    // Act
    const { records, warnings } = parseLiteLlmPayload(payload, FETCHED_AT);

    // Assert
    expect(records.get('claude-fable-5')).toMatchObject({
      inputUsdPerToken: 1e-5,
      cacheWriteUsdPerToken: 1.25e-5,
      source: 'litellm',
    });
    expect(records.get('gpt-5.5')?.cacheWriteUsdPerToken).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  test('builds tiers that inherit unspecified base rates, sorted ascending', () => {
    // Arrange
    const payload = {
      'tiered-model': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        input_cost_per_token_above_272k_tokens: 3e-6,
        input_cost_per_token_above_128k_tokens: 2e-6,
        output_cost_per_token_above_272k_tokens: 4e-6,
      },
    };

    // Act
    const record = parseLiteLlmPayload(payload, FETCHED_AT).records.get('tiered-model');

    // Assert
    expect(record?.tiers.map((tier) => tier.aboveInputTokens)).toEqual([128_000, 272_000]);
    expect(record?.tiers[0]?.rates).toMatchObject({
      inputUsdPerToken: 2e-6,
      outputUsdPerToken: 2e-6,
    });
    expect(record?.tiers[1]?.rates).toMatchObject({
      inputUsdPerToken: 3e-6,
      outputUsdPerToken: 4e-6,
    });
  });

  test('skips invalid entries with one aggregated warning and keeps valid ones', () => {
    // Arrange
    const payload = {
      good: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      negative: { input_cost_per_token: -1, output_cost_per_token: 2e-6 },
      stringy: { input_cost_per_token: '0.001', output_cost_per_token: 2e-6 },
      embedding_only: { input_cost_per_token: 1e-7 },
      bad_tier: {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        input_cost_per_token_above_128k_tokens: 'oops',
      },
    };

    // Act
    const { records, warnings } = parseLiteLlmPayload(payload, FETCHED_AT);

    // Assert
    expect([...records.keys()]).toEqual(['good']);
    expect(warnings).toEqual(['litellm: skipped 3 invalid model entries']);
  });

  test('a non-object payload fails the whole source', () => {
    // Act & Assert
    expect(parseLiteLlmPayload([1, 2], FETCHED_AT).warnings[0]).toContain('not a JSON object');
  });
});

describe('parseOpenRouterPayload', () => {
  const payload = {
    data: [
      { id: 'moonshotai/kimi-k3', pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'other/model', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'bad/model', pricing: { prompt: '-1', completion: '0.1' } },
      { pricing: { prompt: '0.1', completion: '0.1' } },
    ],
  };

  test('keeps only the requested ids and parses decimal strings strictly', () => {
    // Act
    const { records } = parseOpenRouterPayload(
      payload,
      FETCHED_AT,
      new Set(['moonshotai/kimi-k3']),
    );

    // Assert
    expect([...records.keys()]).toEqual(['moonshotai/kimi-k3']);
    expect(records.get('moonshotai/kimi-k3')).toMatchObject({
      inputUsdPerToken: 0.000003,
      outputUsdPerToken: 0.000015,
      source: 'openrouter',
    });
  });

  test('flags invalid entries with an aggregated warning', () => {
    // Act
    const { records, warnings } = parseOpenRouterPayload(payload, FETCHED_AT, null);

    // Assert
    expect(records.has('bad/model')).toBe(false);
    expect(records.size).toBe(2);
    expect(warnings[0]).toContain('skipped 2');
  });
});
