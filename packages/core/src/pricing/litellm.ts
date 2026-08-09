import { asObject } from '../parsers/shared.ts';
import type { PriceRates, PriceRecord, PriceTier } from './types.ts';

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const LITELLM_MAX_BYTES = 8 * 1024 * 1024;

const TIER_FIELD_PATTERN =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/;

export interface ParsedPriceSource {
  readonly records: ReadonlyMap<string, PriceRecord>;
  readonly warnings: readonly string[];
}

export function parseLiteLlmPayload(payload: unknown, fetchedAtUtc: number): ParsedPriceSource {
  const root = asObject(payload);
  if (root === null) {
    return { records: new Map(), warnings: ['litellm payload is not a JSON object'] };
  }
  const records = new Map<string, PriceRecord>();
  let invalidEntries = 0;
  for (const [key, value] of Object.entries(root)) {
    const entry = asObject(value);
    if (entry === null) {
      continue;
    }
    const input = asRate(entry.input_cost_per_token);
    const output = asRate(entry.output_cost_per_token);
    if (input === undefined || output === undefined) {
      invalidEntries += 1;
      continue;
    }
    if (input === null || output === null) {
      // not a per-token chat pricing entry (embeddings, image models, ...)
      continue;
    }
    const cacheRead = asRate(entry.cache_read_input_token_cost);
    const cacheWrite = asRate(entry.cache_creation_input_token_cost);
    if (cacheRead === undefined || cacheWrite === undefined) {
      invalidEntries += 1;
      continue;
    }
    const base: PriceRates = {
      inputUsdPerToken: input,
      outputUsdPerToken: output,
      cacheReadUsdPerToken: cacheRead,
      cacheWriteUsdPerToken: cacheWrite,
    };
    const tiers = parseTiers(entry, base);
    if (tiers === null) {
      invalidEntries += 1;
      continue;
    }
    records.set(key, {
      key,
      source: 'litellm',
      sourceModel: key,
      fetchedAtUtc,
      tiers,
      ...base,
    });
  }
  const warnings =
    invalidEntries > 0 ? [`litellm: skipped ${invalidEntries} invalid model entries`] : [];
  return { records, warnings };
}

/**
 * Tier fields (`*_above_<N>k_tokens`) become full effective rate sets by
 * inheriting the base rates, so downstream never merges partial tiers.
 * Returns null when any tier value is invalid — the whole model entry is
 * then rejected rather than priced with a half-trusted table.
 */
function parseTiers(entry: Record<string, unknown>, base: PriceRates): readonly PriceTier[] | null {
  const byThreshold = new Map<number, Partial<Record<string, number>>>();
  for (const [field, value] of Object.entries(entry)) {
    const match = TIER_FIELD_PATTERN.exec(field);
    if (match === null) {
      continue;
    }
    const rate = asRate(value);
    if (rate === undefined) {
      return null;
    }
    if (rate === null) {
      // an explicit null tier rate simply inherits the base rate
      continue;
    }
    const threshold = Number.parseInt(match[2] ?? '0', 10) * 1000;
    const fields = byThreshold.get(threshold) ?? {};
    fields[match[1] ?? ''] = rate;
    byThreshold.set(threshold, fields);
  }
  const tiers: PriceTier[] = [...byThreshold.entries()]
    .sort(([a], [b]) => a - b)
    .map(([aboveInputTokens, fields]) => ({
      aboveInputTokens,
      rates: {
        inputUsdPerToken: fields.input_cost_per_token ?? base.inputUsdPerToken,
        outputUsdPerToken: fields.output_cost_per_token ?? base.outputUsdPerToken,
        cacheReadUsdPerToken: fields.cache_read_input_token_cost ?? base.cacheReadUsdPerToken,
        cacheWriteUsdPerToken:
          fields.cache_creation_input_token_cost ?? base.cacheWriteUsdPerToken,
      },
    }));
  return tiers;
}

/** undefined = invalid value; null = legitimately missing rate. */
function asRate(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}
