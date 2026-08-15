import type { ReportBucket, ReportSummary } from '@llmtally/core/report/types.ts';
import type { TokenTotals } from '@llmtally/core/pricing/types.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import { primaryCostViewModel, toCostViewModel } from './cost.ts';
import type { CostViewModel } from './cost.ts';

export interface BreakdownRowViewModel {
  readonly key: string;
  /** Ledger rows (API calls) — the footer's "usage rows". */
  readonly rowCount: number;
  /** Distinct prompts — the "Prompts" column and default sort key. */
  readonly promptCount: number;
  readonly tokens: TokenTotals;
  readonly spendCost: CostViewModel;
  readonly quotaCost: CostViewModel;
  readonly unpricedRows: number;
  readonly unknownRows: number;
  readonly unknownUsd: number;
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
    promptCount: bucket.promptCount,
    tokens: bucket.tokens,
    spendCost: toCostViewModel('spend', bucket.spendCost),
    quotaCost: toCostViewModel('quota', bucket.quotaCost),
    unpricedRows: bucket.unpricedRows,
    unknownRows: bucket.unknownRows,
    unknownUsd: bucket.unknownUsd,
  };
}

/** Pure sort selector; ties fall back to key so output stays deterministic. */
export function sortBreakdownRows(
  rows: readonly BreakdownRowViewModel[],
  spec: { column: 'rows' | 'cost' | 'input'; direction: 'asc' | 'desc' },
): readonly BreakdownRowViewModel[] {
  const value = (row: BreakdownRowViewModel): number => {
    if (spec.column === 'cost') {
      // ordering only — each row is ranked by its own primary basis;
      // this never displays a spend+quota sum
      const primary = primaryCostViewModel(row.spendCost, row.quotaCost);
      return primary.usd ?? primary.pricedSubtotalUsd;
    }
    if (spec.column === 'input') {
      return row.tokens.inputTokens;
    }
    return row.promptCount;
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
    if (b.promptCount !== a.promptCount) {
      return b.promptCount - a.promptCount;
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
