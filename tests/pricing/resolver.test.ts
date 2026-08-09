import { describe, expect, test } from 'bun:test';

import { emptyPricingConfig } from '@llmtally/core/pricing/config.ts';
import type { PricingConfig } from '@llmtally/core/pricing/config.ts';
import { resolvePrice } from '@llmtally/core/pricing/resolver.ts';
import type { PriceRecord } from '@llmtally/core/pricing/types.ts';

function record(key: string, source: 'litellm' | 'openrouter' = 'litellm'): PriceRecord {
  return {
    key,
    source,
    sourceModel: key,
    fetchedAtUtc: 0,
    inputUsdPerToken: 1e-6,
    outputUsdPerToken: 2e-6,
    cacheReadUsdPerToken: null,
    cacheWriteUsdPerToken: null,
    tiers: [],
  };
}

function config(aliases: Record<string, string>): PricingConfig {
  return {
    modelAliases: new Map(Object.entries(aliases)),
    priceOverrides: new Map(),
    warnings: [],
  };
}

const sources = {
  litellm: new Map([
    ['gpt-5.5', record('gpt-5.5')],
    ['anthropic/claude-x', record('anthropic/claude-x')],
  ]),
  openrouter: new Map([['moonshotai/kimi-k3', record('moonshotai/kimi-k3', 'openrouter')]]),
};

describe('resolvePrice', () => {
  test('resolves an exact key from litellm first', () => {
    // Act
    const resolution = resolvePrice({
      model: 'gpt-5.5',
      agent: 'codex',
      provider: 'openai',
      config: emptyPricingConfig(),
      sources,
    });

    // Assert
    expect(resolution).toMatchObject({ status: 'resolved', resolution: 'exact' });
  });

  test('follows a scoped alias before a global alias', () => {
    // Act
    const resolution = resolvePrice({
      model: 'gpt-5.5-codex',
      agent: 'codex',
      provider: null,
      config: config({ 'codex:gpt-5.5-codex': 'gpt-5.5', 'gpt-5.5-codex': 'missing' }),
      sources,
    });

    // Assert
    expect(resolution).toMatchObject({ status: 'resolved', resolution: 'scoped_alias' });
  });

  test('a source-qualified alias only searches the pinned source', () => {
    // Act
    const resolution = resolvePrice({
      model: 'kimi-k3',
      agent: 'opencode',
      provider: null,
      config: config({ 'kimi-k3': 'openrouter:moonshotai/kimi-k3' }),
      sources,
    });

    // Assert
    expect(resolution).toMatchObject({
      status: 'resolved',
      resolution: 'global_alias',
    });
    expect(resolution.status === 'resolved' && resolution.record.source).toBe('openrouter');
  });

  test('falls back to the provider-prefixed key', () => {
    // Act
    const resolution = resolvePrice({
      model: 'claude-x',
      agent: 'claude-code',
      provider: 'anthropic',
      config: emptyPricingConfig(),
      sources,
    });

    // Assert
    expect(resolution).toMatchObject({ status: 'resolved', resolution: 'provider_prefixed' });
  });

  test('an override beats every remote source and reports override resolution', () => {
    // Arrange
    const withOverride: PricingConfig = {
      modelAliases: new Map(),
      priceOverrides: new Map([
        [
          'gpt-5.5',
          {
            inputUsdPerToken: 9e-6,
            outputUsdPerToken: 9e-6,
            cacheReadUsdPerToken: null,
            cacheWriteUsdPerToken: null,
          },
        ],
      ]),
      warnings: [],
    };

    // Act
    const resolution = resolvePrice({
      model: 'gpt-5.5',
      agent: 'codex',
      provider: null,
      config: withOverride,
      sources,
    });

    // Assert
    expect(resolution).toMatchObject({ status: 'resolved', resolution: 'override' });
    expect(resolution.status === 'resolved' && resolution.record.inputUsdPerToken).toBe(9e-6);
  });

  test('detects alias cycles and depth overruns', () => {
    // Act
    const cycle = resolvePrice({
      model: 'a',
      agent: 'codex',
      provider: null,
      config: config({ a: 'b', b: 'a' }),
      sources,
    });
    const deep = resolvePrice({
      model: 'd0',
      agent: 'codex',
      provider: null,
      config: config({
        d0: 'd1', d1: 'd2', d2: 'd3', d3: 'd4', d4: 'd5', d5: 'd6', d6: 'd7', d7: 'd8', d8: 'd9',
      }),
      sources,
    });

    // Assert
    expect(cycle).toMatchObject({ status: 'unpriced', reason: 'alias_cycle' });
    expect(deep).toMatchObject({ status: 'unpriced', reason: 'alias_depth_exceeded' });
  });

  test('the unknown model and unmatched models are unpriced', () => {
    // Act & Assert
    expect(
      resolvePrice({ model: 'unknown', agent: 'codex', provider: null, config: emptyPricingConfig(), sources }),
    ).toMatchObject({ status: 'unpriced', reason: 'unknown_model' });
    expect(
      resolvePrice({ model: 'nope', agent: 'codex', provider: null, config: emptyPricingConfig(), sources }),
    ).toMatchObject({ status: 'unpriced', reason: 'not_found' });
  });
});
