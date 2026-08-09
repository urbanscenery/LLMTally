import {
  isSourceAuthoritative,
  minTierThreshold,
  nominalUsdFor,
  selectTierRates,
} from '../pricing/calculator.ts';
import type {
  CostResult,
  CostWarning,
  CostWarningCode,
  PriceResolution,
  TokenTotals,
} from '../pricing/types.ts';
import type { ReportBucket, ReportGroupBy, ReportRow, ReportUsageRow } from './types.ts';

/** Cost fragments computed for one SQL grain row before bucket folding. */
export interface GroupCost {
  readonly actualUsd: number;
  readonly actualRows: number;
  readonly actualMissingRows: number;
  readonly nominalUsd: number;
  readonly nominalRows: number;
  readonly nominalUnpricedRows: number;
  readonly actualWarnings: readonly CostWarning[];
  readonly nominalWarnings: readonly CostWarning[];
}

const NO_ACTUAL = { actualUsd: 0, actualRows: 0, actualMissingRows: 0, actualWarnings: [] } as const;

export function computeGroupCost(
  row: ReportRow,
  resolution: PriceResolution | null,
  iterateRows: () => IterableIterator<ReportUsageRow>,
): GroupCost {
  if (isSourceAuthoritative(row.agent)) {
    const missing = row.rowCount - row.actualCostRows;
    return {
      actualUsd: row.actualCostUsd ?? 0,
      actualRows: row.actualCostRows,
      actualMissingRows: missing,
      nominalUsd: 0,
      nominalRows: 0,
      nominalUnpricedRows: 0,
      actualWarnings:
        missing > 0
          ? [{ code: 'missing_authoritative_cost', model: row.model, rows: missing }]
          : [],
      nominalWarnings: [],
    };
  }

  if (resolution === null || resolution.status === 'unpriced') {
    const code: CostWarningCode =
      resolution?.reason === 'unknown_model' ? 'unknown_model' : 'price_not_found';
    return {
      ...NO_ACTUAL,
      nominalUsd: 0,
      nominalRows: 0,
      nominalUnpricedRows: row.rowCount,
      nominalWarnings: [{ code, model: row.model, rows: row.rowCount }],
    };
  }

  // per-row repricing is needed both for tier crossings and for groups
  // hiding invalid codex rows: a row with input < cacheRead can cancel
  // out inside SUMs and must be rejected individually, not blended
  const record = resolution.record;
  const threshold = minTierThreshold(record);
  const crossesTier = threshold !== null && row.maxInputTokens > threshold;
  if (crossesTier || row.invalidSemanticsRows > 0) {
    return rowLevelGroupCost(row, resolution, iterateRows);
  }

  const outcome = nominalUsdFor(row.agent, row.tokens, record);
  if (!outcome.ok) {
    return {
      ...NO_ACTUAL,
      nominalUsd: 0,
      nominalRows: 0,
      nominalUnpricedRows: row.rowCount,
      nominalWarnings: [{ code: outcome.code, model: row.model, rows: row.rowCount }],
    };
  }
  return {
    ...NO_ACTUAL,
    nominalUsd: outcome.usd,
    nominalRows: row.rowCount,
    nominalUnpricedRows: 0,
    nominalWarnings: [],
  };
}

/**
 * Streamed row-by-row repricing (never materialized as an array): each
 * row picks its own tier rates, and individually invalid rows become
 * unpriced without contaminating the valid rows of the same group.
 */
function rowLevelGroupCost(
  row: ReportRow,
  resolution: Extract<PriceResolution, { status: 'resolved' }>,
  iterateRows: () => IterableIterator<ReportUsageRow>,
): GroupCost {
  let nominalUsd = 0;
  let nominalRows = 0;
  let unpricedRows = 0;
  const warningRows = new Map<CostWarningCode, number>();
  for (const usage of iterateRows()) {
    const rates = selectTierRates(resolution.record, usage.inputTokens);
    const outcome = nominalUsdFor(row.agent, usage, rates);
    if (outcome.ok) {
      nominalUsd += outcome.usd;
      nominalRows += 1;
    } else {
      unpricedRows += 1;
      warningRows.set(outcome.code, (warningRows.get(outcome.code) ?? 0) + 1);
    }
  }
  return {
    ...NO_ACTUAL,
    nominalUsd,
    nominalRows,
    nominalUnpricedRows: unpricedRows,
    nominalWarnings: [...warningRows.entries()].map(([code, rows]) => ({
      code,
      model: row.model,
      rows,
    })),
  };
}

interface MutableBucket {
  key: string;
  rowCount: number;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheWrite: number;
    cacheRead: number;
    reasoningTokens: number;
  };
  actualUsd: number;
  actualRows: number;
  actualMissingRows: number;
  nominalUsd: number;
  nominalRows: number;
  nominalUnpricedRows: number;
  unpricedModels: Set<string>;
  actualWarnings: Map<string, CostWarning>;
  nominalWarnings: Map<string, CostWarning>;
}

export function bucketKeyFor(groupBy: ReportGroupBy, row: ReportRow): string {
  if (groupBy === 'model') {
    return row.model;
  }
  if (groupBy === 'agent') {
    return row.agent;
  }
  return row.bucket;
}

/** Folds priced grain rows into display buckets plus an overall total. */
export function foldBuckets(
  groupBy: ReportGroupBy,
  entries: readonly { row: ReportRow; cost: GroupCost }[],
): { buckets: readonly ReportBucket[]; totals: ReportBucket } {
  const buckets = new Map<string, MutableBucket>();
  const totals = emptyBucket('TOTAL');
  for (const { row, cost } of entries) {
    const key = bucketKeyFor(groupBy, row);
    const bucket = buckets.get(key) ?? emptyBucket(key);
    buckets.set(key, bucket);
    for (const target of [bucket, totals]) {
      accumulate(target, row, cost);
    }
  }
  return {
    buckets: [...buckets.values()].map(freezeBucket),
    totals: freezeBucket(totals),
  };
}

function accumulate(target: MutableBucket, row: ReportRow, cost: GroupCost): void {
  target.rowCount += row.rowCount;
  target.tokens.inputTokens += row.tokens.inputTokens;
  target.tokens.outputTokens += row.tokens.outputTokens;
  target.tokens.cacheWrite += row.tokens.cacheWrite;
  target.tokens.cacheRead += row.tokens.cacheRead;
  target.tokens.reasoningTokens += row.tokens.reasoningTokens;
  target.actualUsd += cost.actualUsd;
  target.actualRows += cost.actualRows;
  target.actualMissingRows += cost.actualMissingRows;
  target.nominalUsd += cost.nominalUsd;
  target.nominalRows += cost.nominalRows;
  target.nominalUnpricedRows += cost.nominalUnpricedRows;
  if (cost.nominalUnpricedRows > 0 || cost.actualMissingRows > 0) {
    target.unpricedModels.add(row.model);
  }
  mergeWarnings(target.actualWarnings, cost.actualWarnings);
  mergeWarnings(target.nominalWarnings, cost.nominalWarnings);
}

function mergeWarnings(target: Map<string, CostWarning>, warnings: readonly CostWarning[]): void {
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.model}`;
    const existing = target.get(key);
    target.set(
      key,
      existing === undefined ? warning : { ...existing, rows: existing.rows + warning.rows },
    );
  }
}

function emptyBucket(key: string): MutableBucket {
  return {
    key,
    rowCount: 0,
    tokens: { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, reasoningTokens: 0 },
    actualUsd: 0,
    actualRows: 0,
    actualMissingRows: 0,
    nominalUsd: 0,
    nominalRows: 0,
    nominalUnpricedRows: 0,
    unpricedModels: new Set(),
    actualWarnings: new Map(),
    nominalWarnings: new Map(),
  };
}

function freezeBucket(bucket: MutableBucket): ReportBucket {
  return {
    key: bucket.key,
    rowCount: bucket.rowCount,
    tokens: { ...bucket.tokens } as TokenTotals,
    actual: costResult(
      'actual',
      bucket.actualUsd,
      bucket.actualRows,
      bucket.actualMissingRows,
      [...bucket.actualWarnings.values()],
    ),
    nominal: costResult(
      'nominal',
      bucket.nominalUsd,
      bucket.nominalRows,
      bucket.nominalUnpricedRows,
      [...bucket.nominalWarnings.values()],
    ),
    unpricedRows: bucket.nominalUnpricedRows + bucket.actualMissingRows,
    unpricedModels: [...bucket.unpricedModels].sort(),
  };
}

function costResult(
  basis: 'actual' | 'nominal',
  subtotalUsd: number,
  pricedRows: number,
  unpricedRows: number,
  warnings: readonly CostWarning[],
): CostResult {
  return {
    basis: pricedRows === 0 && unpricedRows > 0 ? 'unpriced' : basis,
    usd: unpricedRows === 0 && pricedRows > 0 ? subtotalUsd : null,
    pricedSubtotalUsd: subtotalUsd,
    pricedRows,
    unpricedRows,
    warnings,
  };
}
