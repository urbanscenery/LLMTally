import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject } from '../parsers/shared.ts';
import type { PriceRates } from './types.ts';

const CONFIG_VERSION = 1;

export interface PricingConfig {
  readonly modelAliases: ReadonlyMap<string, string>;
  readonly priceOverrides: ReadonlyMap<string, PriceRates>;
  readonly warnings: readonly string[];
}

export function defaultConfigPath(): string {
  return join(homedir(), '.llmtally', 'config.json');
}

export function emptyPricingConfig(warnings: readonly string[] = []): PricingConfig {
  return { modelAliases: new Map(), priceOverrides: new Map(), warnings };
}

/**
 * A broken config must never fail a report: invalid entries are dropped
 * with a warning and everything else keeps working.
 */
export function loadPricingConfig(path: string = defaultConfigPath()): PricingConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyPricingConfig();
    }
    return emptyPricingConfig([`config unreadable: ${describe(error)}`]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyPricingConfig(['config is not valid JSON; ignoring it']);
  }
  const root = asObject(parsed);
  if (root === null || root.version !== CONFIG_VERSION) {
    return emptyPricingConfig([`config version is not ${CONFIG_VERSION}; ignoring it`]);
  }

  const warnings: string[] = [];
  const pricing = asObject(root.pricing) ?? {};
  const modelAliases = new Map<string, string>();
  for (const [alias, target] of Object.entries(asObject(pricing.modelAliases) ?? {})) {
    if (typeof target === 'string' && target.trim().length > 0) {
      modelAliases.set(alias.trim(), target.trim());
    } else {
      warnings.push(`alias "${alias}" has a non-string target; ignored`);
    }
  }

  const priceOverrides = new Map<string, PriceRates>();
  for (const [model, value] of Object.entries(asObject(pricing.priceOverrides) ?? {})) {
    const rates = asOverrideRates(value);
    if (rates === null) {
      warnings.push(`price override "${model}" is invalid; ignored`);
    } else {
      priceOverrides.set(model, rates);
    }
  }

  return { modelAliases, priceOverrides, warnings };
}

function asOverrideRates(value: unknown): PriceRates | null {
  const record = asObject(value);
  if (record === null) {
    return null;
  }
  const input = asRequiredRate(record.inputUsdPerToken);
  const output = asRequiredRate(record.outputUsdPerToken);
  const cacheRead = asOptionalRate(record.cacheReadUsdPerToken);
  const cacheWrite = asOptionalRate(record.cacheWriteUsdPerToken);
  if (input === null || output === null || cacheRead === undefined || cacheWrite === undefined) {
    return null;
  }
  return {
    inputUsdPerToken: input,
    outputUsdPerToken: output,
    cacheReadUsdPerToken: cacheRead,
    cacheWriteUsdPerToken: cacheWrite,
  };
}

function asRequiredRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** undefined marks an invalid value; null is a legitimate missing rate. */
function asOptionalRate(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  const rate = asRequiredRate(value);
  return rate === null ? undefined : rate;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
