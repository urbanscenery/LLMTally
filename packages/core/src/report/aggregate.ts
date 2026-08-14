import type { BillingNature } from '../pricing/billing-nature.ts';
import {
  isSourceAuthoritative,
  listPriceUsdFor,
  minTierThreshold,
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

/**
 * Cost fragments computed for one SQL grain row before bucket folding.
 * Settlement decides the bucket (spend cost vs quota cost); provenance only
 * decides how the dollars inside it were obtained. Unknown rows join
 * neither total — their stamped dollars are carried for display only.
 */
export interface GroupCost {
  readonly spendCostUsd: number;
  readonly spendCostRows: number;
  readonly spendCostUnpricedRows: number;
  readonly quotaCostUsd: number;
  readonly quotaCostRows: number;
  readonly quotaCostUnpricedRows: number;
  readonly unknownUsd: number;
  readonly unknownRows: number;
  readonly spendCostWarnings: readonly CostWarning[];
  readonly quotaCostWarnings: readonly CostWarning[];
}

const EMPTY_GROUP_COST: GroupCost = {
  spendCostUsd: 0,
  spendCostRows: 0,
  spendCostUnpricedRows: 0,
  quotaCostUsd: 0,
  quotaCostRows: 0,
  quotaCostUnpricedRows: 0,
  unknownUsd: 0,
  unknownRows: 0,
  spendCostWarnings: [],
  quotaCostWarnings: [],
};

/** One settlement side of a group before it is placed by nature. */
interface SettledCost {
  readonly usd: number;
  readonly rows: number;
  readonly unpricedRows: number;
  readonly warnings: readonly CostWarning[];
}

export function computeGroupCost(
  row: ReportRow,
  nature: BillingNature,
  resolution: PriceResolution | null,
  iterateRows: () => IterableIterator<ReportUsageRow>,
): GroupCost {
  if (nature === 'unknown') {
    // never guessed into a total; the stamped dollars stay visible so
    // an unclassified provider is loud instead of silently misfiled
    return {
      ...EMPTY_GROUP_COST,
      unknownRows: row.rowCount,
      unknownUsd: row.stampedCostUsd ?? 0,
    };
  }
  const settled = settledCostFor(row, resolution, iterateRows);
  if (nature === 'spend') {
    return {
      ...EMPTY_GROUP_COST,
      spendCostUsd: settled.usd,
      spendCostRows: settled.rows,
      spendCostUnpricedRows: settled.unpricedRows,
      spendCostWarnings: settled.warnings,
    };
  }
  return {
    ...EMPTY_GROUP_COST,
    quotaCostUsd: settled.usd,
    quotaCostRows: settled.rows,
    quotaCostUnpricedRows: settled.unpricedRows,
    quotaCostWarnings: settled.warnings,
  };
}

function settledCostFor(
  row: ReportRow,
  resolution: PriceResolution | null,
  iterateRows: () => IterableIterator<ReportUsageRow>,
): SettledCost {
  if (isSourceAuthoritative(row.agent)) {
    const missing = row.rowCount - row.stampedCostRows;
    return {
      usd: row.stampedCostUsd ?? 0,
      rows: row.stampedCostRows,
      unpricedRows: missing,
      warnings:
        missing > 0
          ? [{ code: 'missing_authoritative_cost', model: row.model, rows: missing }]
          : [],
    };
  }

  if (resolution === null || resolution.status === 'unpriced') {
    const code: CostWarningCode =
      resolution?.reason === 'unknown_model' ? 'unknown_model' : 'price_not_found';
    return {
      usd: 0,
      rows: 0,
      unpricedRows: row.rowCount,
      warnings: [{ code, model: row.model, rows: row.rowCount }],
    };
  }

  // per-row repricing is needed both for tier crossings and for groups
  // hiding invalid codex rows: a row with input < cacheRead can cancel
  // out inside SUMs and must be rejected individually, not blended
  const record = resolution.record;
  const threshold = minTierThreshold(record);
  const crossesTier = threshold !== null && row.maxInputTokens > threshold;
  if (crossesTier || row.invalidSemanticsRows > 0) {
    return rowLevelSettledCost(row, resolution, iterateRows);
  }

  const outcome = listPriceUsdFor(row.agent, row.tokens, record);
  if (!outcome.ok) {
    return {
      usd: 0,
      rows: 0,
      unpricedRows: row.rowCount,
      warnings: [{ code: outcome.code, model: row.model, rows: row.rowCount }],
    };
  }
  return { usd: outcome.usd, rows: row.rowCount, unpricedRows: 0, warnings: [] };
}

/**
 * Streamed row-by-row repricing (never materialized as an array): each
 * row picks its own tier rates, and individually invalid rows become
 * unpriced without contaminating the valid rows of the same group.
 */
function rowLevelSettledCost(
  row: ReportRow,
  resolution: Extract<PriceResolution, { status: 'resolved' }>,
  iterateRows: () => IterableIterator<ReportUsageRow>,
): SettledCost {
  let usd = 0;
  let rows = 0;
  let unpricedRows = 0;
  const warningRows = new Map<CostWarningCode, number>();
  for (const usage of iterateRows()) {
    const rates = selectTierRates(resolution.record, usage.inputTokens);
    const outcome = listPriceUsdFor(row.agent, usage, rates);
    if (outcome.ok) {
      usd += outcome.usd;
      rows += 1;
    } else {
      unpricedRows += 1;
      warningRows.set(outcome.code, (warningRows.get(outcome.code) ?? 0) + 1);
    }
  }
  return {
    usd,
    rows,
    unpricedRows,
    warnings: [...warningRows.entries()].map(([code, count]) => ({
      code,
      model: row.model,
      rows: count,
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
  spendCostUsd: number;
  spendCostRows: number;
  spendCostUnpricedRows: number;
  quotaCostUsd: number;
  quotaCostRows: number;
  quotaCostUnpricedRows: number;
  unknownUsd: number;
  unknownRows: number;
  unpricedModels: Set<string>;
  spendCostWarnings: Map<string, CostWarning>;
  quotaCostWarnings: Map<string, CostWarning>;
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
  target.spendCostUsd += cost.spendCostUsd;
  target.spendCostRows += cost.spendCostRows;
  target.spendCostUnpricedRows += cost.spendCostUnpricedRows;
  target.quotaCostUsd += cost.quotaCostUsd;
  target.quotaCostRows += cost.quotaCostRows;
  target.quotaCostUnpricedRows += cost.quotaCostUnpricedRows;
  target.unknownUsd += cost.unknownUsd;
  target.unknownRows += cost.unknownRows;
  if (cost.spendCostUnpricedRows > 0 || cost.quotaCostUnpricedRows > 0) {
    target.unpricedModels.add(row.model);
  }
  mergeWarnings(target.spendCostWarnings, cost.spendCostWarnings);
  mergeWarnings(target.quotaCostWarnings, cost.quotaCostWarnings);
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
    spendCostUsd: 0,
    spendCostRows: 0,
    spendCostUnpricedRows: 0,
    quotaCostUsd: 0,
    quotaCostRows: 0,
    quotaCostUnpricedRows: 0,
    unknownUsd: 0,
    unknownRows: 0,
    unpricedModels: new Set(),
    spendCostWarnings: new Map(),
    quotaCostWarnings: new Map(),
  };
}

function freezeBucket(bucket: MutableBucket): ReportBucket {
  return {
    key: bucket.key,
    rowCount: bucket.rowCount,
    tokens: { ...bucket.tokens } as TokenTotals,
    spendCost: costResult(
      'spend',
      bucket.spendCostUsd,
      bucket.spendCostRows,
      bucket.spendCostUnpricedRows,
      [...bucket.spendCostWarnings.values()],
    ),
    quotaCost: costResult(
      'quota',
      bucket.quotaCostUsd,
      bucket.quotaCostRows,
      bucket.quotaCostUnpricedRows,
      [...bucket.quotaCostWarnings.values()],
    ),
    unknownRows: bucket.unknownRows,
    unknownUsd: bucket.unknownUsd,
    unpricedRows: bucket.spendCostUnpricedRows + bucket.quotaCostUnpricedRows,
    unpricedModels: [...bucket.unpricedModels].sort(),
  };
}

function costResult(
  basis: 'spend' | 'quota',
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
