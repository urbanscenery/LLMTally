export type PriceSource = 'override' | 'litellm' | 'openrouter';
export type RemotePriceSource = Exclude<PriceSource, 'override'>;

/** All rates are USD per single token; null means the source has no rate. */
export interface PriceRates {
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
  readonly cacheReadUsdPerToken: number | null;
  readonly cacheWriteUsdPerToken: number | null;
}

export interface PriceTier {
  /** Applies when a row's inputTokens is strictly greater than this. */
  readonly aboveInputTokens: number;
  /** Effective rates with base values inherited — never partial. */
  readonly rates: PriceRates;
}

export interface PriceRecord extends PriceRates {
  readonly key: string;
  readonly source: PriceSource;
  readonly sourceModel: string;
  readonly fetchedAtUtc: number;
  readonly tiers: readonly PriceTier[];
}

export type PriceResolutionKind =
  | 'exact'
  | 'scoped_alias'
  | 'global_alias'
  | 'provider_prefixed'
  | 'override';

export interface ResolvedPrice {
  readonly status: 'resolved';
  readonly requestedModel: string;
  readonly resolution: PriceResolutionKind;
  readonly record: PriceRecord;
}

export type UnpricedReason =
  | 'unknown_model'
  | 'not_found'
  | 'alias_cycle'
  | 'alias_depth_exceeded';

export interface UnresolvedPrice {
  readonly status: 'unpriced';
  readonly requestedModel: string;
  readonly reason: UnpricedReason;
}

export type PriceResolution = ResolvedPrice | UnresolvedPrice;

/**
 * Settlement basis of a cost figure: `spend` is real money (card /
 * prepaid credit), `quota` is the list-price valuation of subscription
 * quota consumption. "cost" alone is the umbrella term — the two are
 * named together, never summed together. See pricing/billing-nature.ts.
 */
export type CostBasis = 'spend' | 'quota' | 'unpriced';

export interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly reasoningTokens: number;
}

export type CostWarningCode =
  | 'unknown_model'
  | 'price_not_found'
  | 'missing_cache_read_rate'
  | 'missing_cache_write_rate'
  | 'invalid_token_semantics'
  | 'missing_authoritative_cost'
  | 'partial_authoritative_cost';

export interface CostWarning {
  readonly code: CostWarningCode;
  readonly model: string;
  readonly rows: number;
}

export interface CostResult {
  readonly basis: CostBasis;
  /** Full cost — present only when every row in scope was priced. */
  readonly usd: number | null;
  /** Sum over the rows that could be priced even when usd is null. */
  readonly pricedSubtotalUsd: number;
  readonly pricedRows: number;
  readonly unpricedRows: number;
  readonly warnings: readonly CostWarning[];
}

export type AgentCostFormula =
  | 'claude_separate_cache'
  | 'codex_input_includes_cache_read'
  | 'separate_reasoning'
  | 'source_authoritative';

export interface AgentTokenSemantics {
  readonly version: 1;
  readonly formula: AgentCostFormula;
}

/** Raw-token semantics are stored per agent; pricing must respect them. */
export const AGENT_TOKEN_SEMANTICS: Readonly<Record<string, AgentTokenSemantics>> = {
  'claude-code': { version: 1, formula: 'claude_separate_cache' },
  codex: { version: 1, formula: 'codex_input_includes_cache_read' },
  opencode: { version: 1, formula: 'source_authoritative' },
  cline: { version: 1, formula: 'source_authoritative' },
  // grok_build stamps every turn with costUsdTicks (1e10 ticks = 1 USD),
  // so its own accounting is the price — no table lookup can beat it
  grok: { version: 1, formula: 'source_authoritative' },
  // antigravity stores reasoning separately from text output (verified
  // invariant output+reasoning==total); reasoning bills at output rates
  'antigravity-cli': { version: 1, formula: 'separate_reasoning' },
};

export interface PricingCacheEnvelope {
  readonly version: 1;
  readonly source: RemotePriceSource;
  readonly url: string;
  readonly fetchedAtUtc: number;
  readonly validatedAtUtc: number;
  readonly etag: string | null;
  readonly payloadSha256: string;
  readonly payload: unknown;
}

export type PricingCacheStatus = 'fresh' | 'stale' | 'absent';
