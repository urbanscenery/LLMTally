import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import type { ReportSummary } from '@llmtally/core/report/types.ts';
import type { TokenTotals } from '@llmtally/core/pricing/types.ts';
import { toCostViewModel } from './cost.ts';
import type { CostViewModel } from './cost.ts';

export interface DailyPointViewModel {
  readonly date: string;
  readonly value: number;
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
    readonly actual: CostViewModel;
    readonly nominal: CostViewModel;
    readonly unpricedRows: number;
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
      actual: toCostViewModel('actual', summary.totals.actual),
      nominal: toCostViewModel('nominal', summary.totals.nominal),
      unpricedRows: summary.totals.unpricedRows,
    },
    pricing: {
      status: sanitizeTerminalLine(summary.pricing.status),
      asOfUtc: summary.pricing.asOfUtc,
      warnings: summary.pricing.warnings.map((warning) => sanitizeTerminalLine(warning)),
    },
  };
}
