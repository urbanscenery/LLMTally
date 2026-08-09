import { asObject, asString } from '../parsers/shared.ts';
import type { PriceRecord } from './types.ts';
import type { ParsedPriceSource } from './litellm.ts';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_MAX_BYTES = 4 * 1024 * 1024;

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * OpenRouter is a lazy fallback: parse only the model ids the report
 * actually needs so 400 marketplace entries never sit in memory.
 */
export function parseOpenRouterPayload(
  payload: unknown,
  fetchedAtUtc: number,
  neededKeys: ReadonlySet<string> | null,
): ParsedPriceSource {
  const root = asObject(payload);
  const data = root?.data;
  if (!Array.isArray(data)) {
    return { records: new Map(), warnings: ['openrouter payload has no data array'] };
  }
  const records = new Map<string, PriceRecord>();
  let invalidEntries = 0;
  for (const item of data) {
    const entry = asObject(item);
    const id = entry === null ? null : asString(entry.id);
    if (entry === null || id === null || id.length === 0) {
      invalidEntries += 1;
      continue;
    }
    if (neededKeys !== null && !neededKeys.has(id)) {
      continue;
    }
    const pricing = asObject(entry.pricing);
    const input = parseDecimal(pricing?.prompt);
    const output = parseDecimal(pricing?.completion);
    if (input === null || output === null) {
      invalidEntries += 1;
      continue;
    }
    records.set(id, {
      key: id,
      source: 'openrouter',
      sourceModel: id,
      fetchedAtUtc,
      inputUsdPerToken: input,
      outputUsdPerToken: output,
      cacheReadUsdPerToken: parseDecimal(pricing?.input_cache_read),
      cacheWriteUsdPerToken: parseDecimal(pricing?.input_cache_write),
      tiers: [],
    });
  }
  const warnings =
    invalidEntries > 0 ? [`openrouter: skipped ${invalidEntries} invalid model entries`] : [];
  return { records, warnings };
}

function parseDecimal(value: unknown): number | null {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
