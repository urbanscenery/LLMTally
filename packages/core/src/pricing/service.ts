import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultConfigPath, loadPricingConfig } from './config.ts';
import type { PricingConfig } from './config.ts';
import { loadPricingPayload } from './cache.ts';
import type { CacheSourceResult, FetchLike } from './cache.ts';
import { asObject } from '../parsers/shared.ts';
import { isSourceAuthoritative } from './calculator.ts';
import { LITELLM_MAX_BYTES, LITELLM_URL, parseLiteLlmPayload } from './litellm.ts';
import { OPENROUTER_MAX_BYTES, OPENROUTER_URL, parseOpenRouterPayload } from './openrouter.ts';
import { resolvePrice } from './resolver.ts';
import type { PriceRecord, PriceResolution, PriceSource, PricingCacheStatus } from './types.ts';

export interface NeededModel {
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string;
}

export interface PricingLoadOptions {
  readonly needed: readonly NeededModel[];
  readonly allowRefresh: boolean;
  readonly fetchFn?: FetchLike;
  readonly cacheDir?: string;
  readonly configPath?: string;
  readonly nowUtc?: number;
}

export interface LoadedPricing {
  readonly resolutions: ReadonlyMap<string, PriceResolution>;
  readonly status: PricingCacheStatus | 'mixed';
  readonly asOfUtc: number | null;
  readonly sources: readonly PriceSource[];
  readonly warnings: readonly string[];
}

export function pricingKey(agent: string, provider: string | null, model: string): string {
  return `${agent}\u0000${provider ?? ''}\u0000${model}`;
}

/**
 * LiteLLM is the primary source; OpenRouter is fetched lazily and only
 * when some nominal-priced model stayed unresolved. Source-authoritative
 * agents (opencode) never need a price table at all.
 */
export async function loadPricing(options: PricingLoadOptions): Promise<LoadedPricing> {
  const warnings: string[] = [];
  const config = loadPricingConfig(options.configPath ?? defaultConfigPath());
  warnings.push(...config.warnings);

  const nominalNeeded = options.needed.filter((need) => !isSourceAuthoritative(need.agent));
  const resolutions = new Map<string, PriceResolution>();
  if (nominalNeeded.length === 0) {
    return { resolutions, status: 'fresh', asOfUtc: null, sources: [], warnings };
  }

  const cacheDir = options.cacheDir ?? join(homedir(), '.llmtally', 'cache');
  const litellmResult = await loadPricingPayload({
    source: 'litellm',
    url: LITELLM_URL,
    cachePath: join(cacheDir, 'pricing-litellm.json'),
    maxBytes: LITELLM_MAX_BYTES,
    allowRefresh: options.allowRefresh,
    fetchFn: options.fetchFn,
    nowUtc: options.nowUtc,
    validatePayload: (payload) => asObject(payload) !== null,
  });
  warnings.push(...litellmResult.warnings);
  const litellm = parseSource(litellmResult, (payload, fetchedAt) =>
    parseLiteLlmPayload(payload, fetchedAt),
  );
  warnings.push(...litellm.warnings);

  const sources: { litellm: ReadonlyMap<string, PriceRecord> | null; openrouter: ReadonlyMap<string, PriceRecord> | null } = {
    litellm: litellm.records,
    openrouter: null,
  };
  for (const need of nominalNeeded) {
    resolutions.set(
      pricingKey(need.agent, need.provider, need.model),
      resolvePrice({ model: need.model, agent: need.agent, provider: need.provider, config, sources }),
    );
  }

  const unresolved = nominalNeeded.filter((need) => {
    const resolution = resolutions.get(pricingKey(need.agent, need.provider, need.model));
    return resolution?.status === 'unpriced' && resolution.reason === 'not_found';
  });

  let openRouterStatus: PricingCacheStatus | null = null;
  let openRouterFetchedAt: number | null = null;
  if (unresolved.length > 0) {
    const openRouterResult = await loadPricingPayload({
      source: 'openrouter',
      url: OPENROUTER_URL,
      cachePath: join(cacheDir, 'pricing-openrouter.json'),
      maxBytes: OPENROUTER_MAX_BYTES,
      allowRefresh: options.allowRefresh,
      fetchFn: options.fetchFn,
      nowUtc: options.nowUtc,
      validatePayload: (payload) => Array.isArray(asObject(payload)?.data),
    });
    warnings.push(...openRouterResult.warnings);
    openRouterStatus = openRouterResult.status;
    openRouterFetchedAt = openRouterResult.fetchedAtUtc;
    const neededKeys = openRouterCandidateKeys(unresolved, config);
    const openrouter = parseSource(openRouterResult, (payload, fetchedAt) =>
      parseOpenRouterPayload(payload, fetchedAt, neededKeys),
    );
    warnings.push(...openrouter.warnings);
    sources.openrouter = openrouter.records;
    for (const need of unresolved) {
      resolutions.set(
        pricingKey(need.agent, need.provider, need.model),
        resolvePrice({ model: need.model, agent: need.agent, provider: need.provider, config, sources }),
      );
    }
  }

  const usedSources = new Set<PriceSource>();
  for (const resolution of resolutions.values()) {
    if (resolution.status === 'resolved') {
      usedSources.add(resolution.record.source);
    }
  }

  return {
    resolutions,
    status: combineStatus(litellmResult.status, openRouterStatus),
    asOfUtc: earliest(litellmResult.fetchedAtUtc, openRouterFetchedAt),
    sources: [...usedSources],
    warnings,
  };
}

function parseSource(
  result: CacheSourceResult,
  parse: (payload: unknown, fetchedAtUtc: number) => {
    records: ReadonlyMap<string, PriceRecord>;
    warnings: readonly string[];
  },
): { records: ReadonlyMap<string, PriceRecord> | null; warnings: readonly string[] } {
  if (result.payload === null) {
    return { records: null, warnings: [] };
  }
  return parse(result.payload, result.fetchedAtUtc ?? 0);
}

/** Every key an unresolved model could reach: itself, provider/model, alias targets. */
function openRouterCandidateKeys(
  unresolved: readonly NeededModel[],
  config: PricingConfig,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const need of unresolved) {
    keys.add(need.model);
    if (need.provider !== null) {
      keys.add(`${need.provider}/${need.model}`);
    }
  }
  for (const target of config.modelAliases.values()) {
    keys.add(target.startsWith('openrouter:') ? target.slice('openrouter:'.length) : target);
  }
  return keys;
}

function combineStatus(
  litellm: PricingCacheStatus,
  openrouter: PricingCacheStatus | null,
): PricingCacheStatus | 'mixed' {
  if (openrouter === null || openrouter === litellm) {
    return litellm;
  }
  return 'mixed';
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.min(a, b);
}
