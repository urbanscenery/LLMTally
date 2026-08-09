import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPricingConfig } from '@llmtally/core/pricing/config.ts';
import { makeTempDir } from '../helpers.ts';

function writeConfig(value: unknown): string {
  const path = join(makeTempDir(), 'config.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

describe('loadPricingConfig', () => {
  test('loads aliases and overrides from a valid config', () => {
    // Arrange
    const path = writeConfig({
      version: 1,
      pricing: {
        modelAliases: { 'codex:gpt-5.5-codex': 'gpt-5.5', 'kimi-k3': 'openrouter:moonshotai/kimi-k3' },
        priceOverrides: {
          'private/custom': {
            inputUsdPerToken: 0.00001,
            outputUsdPerToken: 0.00005,
            cacheReadUsdPerToken: null,
          },
        },
      },
    });

    // Act
    const config = loadPricingConfig(path);

    // Assert
    expect(config.modelAliases.get('codex:gpt-5.5-codex')).toBe('gpt-5.5');
    expect(config.priceOverrides.get('private/custom')).toEqual({
      inputUsdPerToken: 0.00001,
      outputUsdPerToken: 0.00005,
      cacheReadUsdPerToken: null,
      cacheWriteUsdPerToken: null,
    });
    expect(config.warnings).toHaveLength(0);
  });

  test('a missing config file is silently empty', () => {
    // Act
    const config = loadPricingConfig(join(makeTempDir(), 'none.json'));

    // Assert
    expect(config.modelAliases.size).toBe(0);
    expect(config.warnings).toHaveLength(0);
  });

  test('malformed json and wrong versions degrade to empty with warnings', () => {
    // Act & Assert
    expect(loadPricingConfig(writeConfig('{not json')).warnings[0]).toContain('not valid JSON');
    expect(loadPricingConfig(writeConfig({ version: 2 })).warnings[0]).toContain('version');
  });

  test('invalid override entries are dropped individually with warnings', () => {
    // Arrange
    const path = writeConfig({
      version: 1,
      pricing: {
        priceOverrides: {
          'bad-negative': { inputUsdPerToken: -1, outputUsdPerToken: 1 },
          'bad-string': { inputUsdPerToken: '0.1', outputUsdPerToken: 1 },
          good: { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000004 },
        },
      },
    });

    // Act
    const config = loadPricingConfig(path);

    // Assert
    expect(config.priceOverrides.has('good')).toBe(true);
    expect(config.priceOverrides.has('bad-negative')).toBe(false);
    expect(config.warnings).toHaveLength(2);
  });
});
