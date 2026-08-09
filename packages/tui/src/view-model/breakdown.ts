import type { ReportBucket, ReportSummary } from '@llmtally/core/report/types.ts';
import type { TokenTotals } from '@llmtally/core/pricing/types.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import { toCostViewModel } from './cost.ts';
import type { CostViewModel } from './cost.ts';

export interface BreakdownRowViewModel {
  readonly key: string;
  readonly rowCount: number;
  readonly tokens: TokenTotals;
  readonly actual: CostViewModel;
  readonly nominal: CostViewModel;
  readonly unpricedRows: number;
}

export interface BreakdownTabViewModel {
  readonly kind: 'agent' | 'model';
  readonly rows: readonly BreakdownRowViewModel[];
  readonly totals: BreakdownRowViewModel;
  readonly pricing: {
    readonly status: string;
    readonly warnings: readonly string[];
  };
}

function toRow(bucket: ReportBucket): BreakdownRowViewModel {
  return {
    key: sanitizeTerminalLine(bucket.key),
    rowCount: bucket.rowCount,
    tokens: bucket.tokens,
    actual: toCostViewModel('actual', bucket.actual),
    nominal: toCostViewModel('nominal', bucket.nominal),
    unpricedRows: bucket.unpricedRows,
  };
}

/** Pure sort selector; ties fall back to key so output stays deterministic. */
export function sortBreakdownRows(
  rows: readonly BreakdownRowViewModel[],
  spec: { column: 'rows' | 'actual' | 'input'; direction: 'asc' | 'desc' },
): readonly BreakdownRowViewModel[] {
  const value = (row: BreakdownRowViewModel): number => {
    if (spec.column === 'actual') {
      return row.actual.usd ?? row.actual.pricedSubtotalUsd;
    }
    if (spec.column === 'input') {
      return row.tokens.inputTokens;
    }
    return row.rowCount;
  };
  const sign = spec.direction === 'desc' ? -1 : 1;
  return rows.toSorted((a, b) => {
    const diff = (value(a) - value(b)) * sign;
    if (diff !== 0) {
      return diff;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** Deterministic order: busiest first, then key for stable snapshots. */
export function toBreakdownViewModel(
  kind: 'agent' | 'model',
  summary: ReportSummary,
): BreakdownTabViewModel {
  const rows = summary.buckets.map(toRow).toSorted((a, b) => {
    if (b.rowCount !== a.rowCount) {
      return b.rowCount - a.rowCount;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return {
    kind,
    rows,
    totals: { ...toRow(summary.totals), key: 'total' },
    pricing: {
      status: sanitizeTerminalLine(summary.pricing.status),
      warnings: summary.pricing.warnings.map((warning) => sanitizeTerminalLine(warning)),
    },
  };
}
