import type { PricingConfig } from './config.ts';
import type {
  PriceRecord,
  PriceResolution,
  PriceResolutionKind,
  UnpricedReason,
} from './types.ts';

const MAX_ALIAS_DEPTH = 8;
const UNKNOWN_MODEL = 'unknown';

export interface PriceSources {
  readonly litellm: ReadonlyMap<string, PriceRecord> | null;
  readonly openrouter: ReadonlyMap<string, PriceRecord> | null;
}

export interface ResolvePriceInput {
  readonly model: string;
  readonly agent: string;
  readonly provider: string | null;
  readonly config: PricingConfig;
  readonly sources: PriceSources;
}

/**
 * Resolution is deliberately exact-match only (no fuzzy matching — a
 * wrong price silently applied is worse than an unpriced row):
 * exact key -> scoped alias (agent:model) -> global alias -> provider/model.
 * Alias targets may chain (with cycle and depth guards) and may pin a
 * source with a "litellm:" or "openrouter:" prefix.
 */
export function resolvePrice(input: ResolvePriceInput): PriceResolution {
  if (input.model === UNKNOWN_MODEL) {
    return unpriced(input.model, 'unknown_model');
  }

  const direct = lookup(input, input.model, null);
  if (direct !== null) {
    return resolved(input.model, 'exact', direct);
  }

  const scoped = input.config.modelAliases.get(`${input.agent}:${input.model}`);
  if (scoped !== undefined) {
    return followAliasChain(input, scoped, 'scoped_alias');
  }

  const global = input.config.modelAliases.get(input.model);
  if (global !== undefined) {
    return followAliasChain(input, global, 'global_alias');
  }

  if (input.provider !== null) {
    const prefixed = lookup(input, `${input.provider}/${input.model}`, null);
    if (prefixed !== null) {
      return resolved(input.model, 'provider_prefixed', prefixed);
    }
  }

  return unpriced(input.model, 'not_found');
}

function followAliasChain(
  input: ResolvePriceInput,
  firstTarget: string,
  kind: PriceResolutionKind,
): PriceResolution {
  const visited = new Set<string>();
  let target = firstTarget;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    if (visited.has(target)) {
      return unpriced(input.model, 'alias_cycle');
    }
    visited.add(target);

    const sourceQualified = splitSourceQualifier(target);
    const record = lookup(input, sourceQualified.key, sourceQualified.source);
    if (record !== null) {
      return resolved(input.model, kind, record);
    }
    const next = input.config.modelAliases.get(sourceQualified.key);
    if (next === undefined) {
      return unpriced(input.model, 'not_found');
    }
    target = next;
  }
  return unpriced(input.model, 'alias_depth_exceeded');
}

function splitSourceQualifier(target: string): {
  key: string;
  source: 'litellm' | 'openrouter' | null;
} {
  if (target.startsWith('litellm:')) {
    return { key: target.slice('litellm:'.length), source: 'litellm' };
  }
  if (target.startsWith('openrouter:')) {
    return { key: target.slice('openrouter:'.length), source: 'openrouter' };
  }
  return { key: target, source: null };
}

function lookup(
  input: ResolvePriceInput,
  key: string,
  restrictTo: 'litellm' | 'openrouter' | null,
): PriceRecord | null {
  if (restrictTo === null) {
    const override = input.config.priceOverrides.get(key);
    if (override !== undefined) {
      return {
        key,
        source: 'override',
        sourceModel: key,
        fetchedAtUtc: 0,
        tiers: [],
        ...override,
      };
    }
  }
  if (restrictTo !== 'openrouter') {
    const record = input.sources.litellm?.get(key);
    if (record !== undefined) {
      return record;
    }
  }
  if (restrictTo !== 'litellm') {
    const record = input.sources.openrouter?.get(key);
    if (record !== undefined) {
      return record;
    }
  }
  return null;
}

function resolved(
  requestedModel: string,
  resolution: PriceResolutionKind,
  record: PriceRecord,
): PriceResolution {
  return {
    status: 'resolved',
    requestedModel,
    resolution: record.source === 'override' ? 'override' : resolution,
    record,
  };
}

function unpriced(requestedModel: string, reason: UnpricedReason): PriceResolution {
  return { status: 'unpriced', requestedModel, reason };
}
