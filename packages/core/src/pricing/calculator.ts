import { AGENT_TOKEN_SEMANTICS } from './types.ts';
import type {
  CostWarningCode,
  PriceRates,
  PriceRecord,
  TokenTotals,
} from './types.ts';

export type ListPriceOutcome =
  | { readonly ok: true; readonly usd: number }
  | { readonly ok: false; readonly code: CostWarningCode };

/** Tier thresholds apply strictly above their boundary (per source naming). */
export function selectTierRates(record: PriceRecord, inputTokens: number): PriceRates {
  let rates: PriceRates = record;
  for (const tier of record.tiers) {
    if (inputTokens > tier.aboveInputTokens) {
      rates = tier.rates;
    } else {
      break;
    }
  }
  return rates;
}

/** The lowest tier boundary, or null when the record has no tiers. */
export function minTierThreshold(record: PriceRecord): number | null {
  return record.tiers.length > 0 ? (record.tiers[0]?.aboveInputTokens ?? null) : null;
}

export function isSourceAuthoritative(agent: string): boolean {
  return AGENT_TOKEN_SEMANTICS[agent]?.formula === 'source_authoritative';
}

/**
 * Applies the per-agent raw-token semantics. Rates that are missing for a
 * dimension the usage actually consumed make the computation refuse — a
 * guessed rate is worse than an unpriced row.
 */
export function listPriceUsdFor(
  agent: string,
  tokens: TokenTotals,
  rates: PriceRates,
): ListPriceOutcome {
  const semantics = AGENT_TOKEN_SEMANTICS[agent];
  if (semantics === undefined || semantics.formula === 'source_authoritative') {
    return { ok: false, code: 'price_not_found' };
  }

  let baseInputTokens = tokens.inputTokens;
  if (semantics.formula === 'codex_input_includes_cache_read') {
    if (tokens.inputTokens < tokens.cacheRead) {
      return { ok: false, code: 'invalid_token_semantics' };
    }
    baseInputTokens = tokens.inputTokens - tokens.cacheRead;
  }
  if (tokens.cacheRead > 0 && rates.cacheReadUsdPerToken === null) {
    return { ok: false, code: 'missing_cache_read_rate' };
  }
  if (tokens.cacheWrite > 0 && rates.cacheWriteUsdPerToken === null) {
    return { ok: false, code: 'missing_cache_write_rate' };
  }

  // most sources fold reasoning into outputTokens (never priced twice);
  // separate_reasoning sources store it apart and bill it at output rates
  const reasoningBilledTokens =
    semantics.formula === 'separate_reasoning' ? tokens.reasoningTokens : 0;
  const usd =
    baseInputTokens * rates.inputUsdPerToken +
    (tokens.outputTokens + reasoningBilledTokens) * rates.outputUsdPerToken +
    tokens.cacheRead * (rates.cacheReadUsdPerToken ?? 0) +
    tokens.cacheWrite * (rates.cacheWriteUsdPerToken ?? 0);
  return { ok: true, usd };
}
