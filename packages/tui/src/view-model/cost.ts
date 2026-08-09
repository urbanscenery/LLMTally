import type { CostResult } from '@llmtally/core/pricing/types.ts';
import { formatUsdAmount } from '../format.ts';

/**
 * Display model for one cost basis. Actual and nominal are separate
 * values by design — no code path may add them together.
 */
export interface CostViewModel {
  readonly basis: 'actual' | 'nominal';
  readonly usd: number | null;
  readonly pricedSubtotalUsd: number;
  readonly pricedRows: number;
  readonly unpricedRows: number;
  /** True when only part of the rows could be priced. */
  readonly partial: boolean;
}

export function toCostViewModel(basis: 'actual' | 'nominal', cost: CostResult): CostViewModel {
  return {
    basis,
    usd: cost.usd,
    pricedSubtotalUsd: cost.pricedSubtotalUsd,
    pricedRows: cost.pricedRows,
    unpricedRows: cost.unpricedRows,
    partial: cost.usd === null && cost.pricedRows > 0,
  };
}

/**
 * NO_COLOR-safe textual convention: actual = `$ 1.23`, nominal = `~$ 1.23`
 * (the tilde marks the non-billed, API-equivalent figure).
 */
export function formatCostCell(cost: CostViewModel): string {
  const prefix = cost.basis === 'nominal' ? '~$' : '$';
  if (cost.usd !== null) {
    return `${prefix} ${formatUsdAmount(cost.usd)}`;
  }
  if (cost.partial) {
    return `${prefix} ${formatUsdAmount(cost.pricedSubtotalUsd)}+`;
  }
  return '—';
}
