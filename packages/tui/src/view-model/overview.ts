import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import type { ReportSummary } from '@llmtally/core/report/types.ts';
import type { TokenTotals } from '@llmtally/core/pricing/types.ts';
import { toCostViewModel } from './cost.ts';
import type { CostViewModel } from './cost.ts';

export interface DailyPointViewModel {
  readonly date: string;
  readonly value: number;
  /** The day's full bucket, so selecting a date needs no extra query. */
  readonly rowCount: number;
  readonly tokens: TokenTotals;
  readonly spendCost: CostViewModel;
  readonly quotaCost: CostViewModel;
  readonly unknownRows: number;
  readonly unknownUsd: number;
}

export interface OverviewViewModel {
  readonly chart: {
    /** Input tokens only: per-agent semantics differ, so no cross-field total. */
    readonly metric: 'input_tokens';
    readonly points: readonly DailyPointViewModel[];
    readonly maxValue: number;
  };
  readonly totals: {
    readonly rowCount: number;
    readonly tokens: TokenTotals;
    readonly spendCost: CostViewModel;
    readonly quotaCost: CostViewModel;
    readonly unpricedRows: number;
    /** Rows whose billing nature is unclassified — in neither total. */
    readonly unknownRows: number;
    readonly unknownUsd: number;
  };
  readonly pricing: {
    readonly status: string;
    readonly asOfUtc: number | null;
    readonly warnings: readonly string[];
  };
}

/** Day buckets arrive sorted from SQLite; the view only slices them. */
export function toOverviewViewModel(summary: ReportSummary): OverviewViewModel {
  const points = summary.buckets.map((bucket) => ({
    date: sanitizeTerminalLine(bucket.key),
    value: Math.max(0, bucket.tokens.inputTokens),
    rowCount: bucket.rowCount,
    tokens: bucket.tokens,
    spendCost: toCostViewModel('spend', bucket.spendCost),
    quotaCost: toCostViewModel('quota', bucket.quotaCost),
    unknownRows: bucket.unknownRows,
    unknownUsd: bucket.unknownUsd,
  }));
  return {
    chart: {
      metric: 'input_tokens',
      points,
      maxValue: points.reduce((max, point) => Math.max(max, point.value), 0),
    },
    totals: {
      rowCount: summary.totals.rowCount,
      tokens: summary.totals.tokens,
      spendCost: toCostViewModel('spend', summary.totals.spendCost),
      quotaCost: toCostViewModel('quota', summary.totals.quotaCost),
      unpricedRows: summary.totals.unpricedRows,
      unknownRows: summary.totals.unknownRows,
      unknownUsd: summary.totals.unknownUsd,
    },
    pricing: {
      status: sanitizeTerminalLine(summary.pricing.status),
      asOfUtc: summary.pricing.asOfUtc,
      warnings: summary.pricing.warnings.map((warning) => sanitizeTerminalLine(warning)),
    },
  };
}
