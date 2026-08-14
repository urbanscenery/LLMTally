import { formatCompact, formatUsdAmount } from '../format.ts';
import { joinColumns, renderCard } from './card.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import { formatCostCell } from '../view-model/cost.ts';
import type { OverviewViewModel } from '../view-model/overview.ts';

export const QUOTA_COST_DISCLAIMER =
  '~ Quota cost = list-price valuation of subscription-quota consumption; not billed money. Valuation bases differ per source.';

const CARD_WIDTH = 38;
const STACK_BREAKPOINT = 82;

function quotaCostContent(model: OverviewViewModel): RichLine[] {
  const cost = model.totals.quotaCost;
  const note = cost.partial
    ? `partial: ${cost.unpricedRows} rows unpriced`
    : cost.pricedRows === 0
      ? 'no priceable rows'
      : `${cost.pricedRows} rows quota-valued`;
  return [
    joinLine(span(formatCostCell(cost), 'quotaCost')),
    joinLine(span(note, 'muted')),
  ];
}

function spendContent(model: OverviewViewModel): RichLine[] {
  const cost = model.totals.spendCost;
  const note = cost.partial
    ? `partial: ${cost.unpricedRows} rows unpriced`
    : `${cost.pricedRows} billed rows`;
  return [
    joinLine(span(formatCostCell(cost), 'spendCost')),
    joinLine(span(note, 'muted')),
  ];
}

/** True when any row settled as real money (spend card earns its slot). */
export function hasSpend(model: OverviewViewModel): boolean {
  return model.totals.spendCost.pricedRows > 0 || model.totals.spendCost.unpricedRows > 0;
}

/**
 * Usage is the default single card — on a subscription-only ledger a
 * permanent empty SPEND card would just re-create the old two-card
 * confusion. Spend appears only when real money exists, and the two are
 * never summed; below the stack breakpoint the cards stack vertically.
 */
export function renderCostSummary(model: OverviewViewModel, width: number): RichLine[] {
  const quotaCard = renderCard({
    title: 'QUOTA COST (list-price)',
    content: quotaCostContent(model),
    width: Math.min(CARD_WIDTH, width - 2),
  });
  if (!hasSpend(model)) {
    return quotaCard.map((line) => joinLine(' ', line));
  }
  const spendCard = renderCard({
    title: 'SPEND COST (billed money)',
    content: spendContent(model),
    width: Math.min(CARD_WIDTH, width - 2),
  });
  if (width < STACK_BREAKPOINT) {
    return [
      ...spendCard.map((line) => joinLine(' ', line)),
      ...quotaCard.map((line) => joinLine(' ', line)),
    ];
  }
  return joinColumns(spendCard, quotaCard, CARD_WIDTH).map((line) => joinLine(' ', line));
}

/** Footnote for rows the classifier refused to file (loud, not lost). */
export function unclassifiedNote(model: OverviewViewModel): string | null {
  const { unknownRows, unknownUsd } = model.totals;
  if (unknownRows === 0) {
    return null;
  }
  return `? ${unknownRows.toLocaleString('en-US')} rows unclassified ($ ${formatUsdAmount(unknownUsd)} stamped) — not in any total; set billing.overrides in config.json`;
}

export function renderTokenSummary(model: OverviewViewModel): string {
  const tokens = model.totals.tokens;
  return [
    ` rows ${model.totals.rowCount.toLocaleString('en-US')}`,
    `in ${formatCompact(tokens.inputTokens)}`,
    `out ${formatCompact(tokens.outputTokens)}`,
    `cacheR ${formatCompact(tokens.cacheRead)}`,
    `cacheW ${formatCompact(tokens.cacheWrite)}`,
    `reason ${formatCompact(tokens.reasoningTokens)}`,
  ].join(' · ');
}
