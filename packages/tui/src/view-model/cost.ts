import type { CostResult } from '@llmtally/core/pricing/types.ts';
import { formatUsdAmount } from '../format.ts';

/**
 * Display model for one settlement basis. Spend cost (real money) and quota cost
 * (list-price valuation of quota consumption) are separate values by
 * design — no code path may add them together. Usage totals may fold
 * across agents because they share one settlement class; spend+quota
 * would mix billed and never-billed dollars.
 */
export interface CostViewModel {
  readonly basis: 'spend' | 'quota';
  readonly usd: number | null;
  readonly pricedSubtotalUsd: number;
  readonly pricedRows: number;
  readonly unpricedRows: number;
  /** True when only part of the rows could be priced. */
  readonly partial: boolean;
}

export function toCostViewModel(basis: 'spend' | 'quota', cost: CostResult): CostViewModel {
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
 * The one cost figure that means something for this row: spend when any
 * real money was involved, quota cost otherwise. Data decides — never a user
 * setting — and the `$`/`~$` prefix keeps the chosen basis visible, so
 * rows of different bases cannot be confused. Totals must NOT use this:
 * summing a mix of billed and quota-valued dollars is a category error.
 */
export function primaryCostViewModel(spendCost: CostViewModel, quotaCost: CostViewModel): CostViewModel {
  return spendCost.pricedRows > 0 ? spendCost : quotaCost;
}

/**
 * NO_COLOR-safe textual convention: spend = `$ 1.23`, quota = `~$ 1.23`
 * (the tilde marks the non-billed, list-price valuation).
 */
export function formatCostCell(cost: CostViewModel): string {
  const prefix = cost.basis === 'quota' ? '~$' : '$';
  if (cost.usd !== null) {
    return `${prefix} ${formatUsdAmount(cost.usd)}`;
  }
  if (cost.partial) {
    return `${prefix} ${formatUsdAmount(cost.pricedSubtotalUsd)}+`;
  }
  return '—';
}
