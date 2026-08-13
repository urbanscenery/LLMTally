import type {
  CostResult,
  PriceSource,
  PricingCacheStatus,
  TokenTotals,
} from '../pricing/types.ts';

export type ReportGroupBy = 'day' | 'hour' | 'model' | 'agent';

/**
 * Calendar dates in the machine's local timezone. Conversion to UTC
 * epochs happens inside the repository via SQLite so that range
 * filtering and day bucketing share one timezone implementation.
 */
export interface ReportRange {
  readonly fromDate: string | null;
  readonly toDate: string | null;
}

export interface ReportQuery {
  readonly groupBy: ReportGroupBy;
  readonly range: ReportRange;
  readonly agent: string | null;
}

export interface ReportRequest extends ReportQuery {
  readonly databasePath: string;
  readonly noRefresh: boolean;
}

/** One SQL aggregation row at (bucket, agent, provider, model) grain. */
export interface ReportRow {
  readonly bucket: string;
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string;
  readonly rowCount: number;
  readonly tokens: TokenTotals;
  readonly actualCostUsd: number | null;
  readonly actualCostRows: number;
  readonly maxInputTokens: number;
  /** Codex rows whose input_tokens < cache_read (cancel out in SUMs). */
  readonly invalidSemanticsRows: number;
}

/** One ledger row streamed back for tier-priced groups. */
export interface ReportUsageRow {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly reasoningTokens: number;
}

export interface ReportBucket {
  readonly key: string;
  readonly rowCount: number;
  readonly tokens: TokenTotals;
  readonly actual: CostResult;
  readonly nominal: CostResult;
  readonly unpricedRows: number;
  readonly unpricedModels: readonly string[];
}

export interface ReportPricingMetadata {
  readonly status: PricingCacheStatus | 'mixed';
  readonly asOfUtc: number | null;
  readonly sources: readonly PriceSource[];
  readonly warnings: readonly string[];
}

export interface ReportSummary {
  readonly command: 'report';
  readonly databasePath: string;
  readonly groupBy: ReportGroupBy;
  readonly agent: string | null;
  readonly range: ReportRange;
  readonly buckets: readonly ReportBucket[];
  readonly totals: ReportBucket;
  readonly pricing: ReportPricingMetadata;
}
