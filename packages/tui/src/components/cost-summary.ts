import { formatCompact } from '../format.ts';
import { joinColumns, renderCard } from './card.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import { formatCostCell } from '../view-model/cost.ts';
import type { OverviewViewModel } from '../view-model/overview.ts';

export const NOMINAL_DISCLAIMER =
  '* Nominal = API-equivalent value at public list prices; subscription usage is not billed at this amount.';

const CARD_WIDTH = 38;
const STACK_BREAKPOINT = 82;

function actualContent(model: OverviewViewModel): RichLine[] {
  const cost = model.totals.actual;
  return [
    joinLine(span(formatCostCell(cost), 'actualCost')),
    joinLine(
      span(
        cost.pricedRows === 0 ? 'no source-billed rows' : `${cost.pricedRows} source-billed rows`,
        'muted',
      ),
    ),
  ];
}

function nominalContent(model: OverviewViewModel): RichLine[] {
  const cost = model.totals.nominal;
  const note = cost.partial
    ? `partial: ${cost.unpricedRows} rows unpriced`
    : cost.pricedRows === 0
      ? 'no priceable rows'
      : `${cost.pricedRows} rows at list prices`;
  return [
    joinLine(span(formatCostCell(cost), 'nominalCost')),
    joinLine(span(note, 'muted')),
  ];
}

/**
 * Actual and nominal are separate cards on purpose (never summed);
 * below the stack breakpoint the cards stack vertically.
 */
export function renderCostSummary(model: OverviewViewModel, width: number): RichLine[] {
  const left = renderCard({
    title: 'ACTUAL (out-of-pocket)',
    content: actualContent(model),
    width: Math.min(CARD_WIDTH, width - 2),
  });
  const right = renderCard({
    title: 'NOMINAL (API-equivalent)',
    content: nominalContent(model),
    width: Math.min(CARD_WIDTH, width - 2),
  });
  if (width < STACK_BREAKPOINT) {
    return [...left.map((line) => joinLine(' ', line)), ...right.map((line) => joinLine(' ', line))];
  }
  return joinColumns(left, right, CARD_WIDTH).map((line) => joinLine(' ', line));
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
