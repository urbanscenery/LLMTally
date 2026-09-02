/**
 * Detail section for a chart day selected on the Overview: the day's
 * own totals (already on the chart point), then one card per agent
 * with that agent's models nested inside — agents and models are
 * parent and child, so they must not read as two parallel lists.
 * Replaces the all-time cost cards while a day is selected.
 */
import { formatCompact } from '../format.ts';
import { renderCard } from './card.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import { padEndWidth, padStartWidth, truncateToWidth } from '../text.ts';
import type { ResourceState } from '../types.ts';
import { formatCostCell, primaryCostViewModel } from '../view-model/cost.ts';
import type { CostViewModel } from '../view-model/cost.ts';
import type { BreakdownRowViewModel } from '../view-model/breakdown.ts';
import type { DayAgentDetailViewModel, DayDetailViewModel } from '../view-model/day-detail.ts';
import type { DailyPointViewModel } from '../view-model/overview.ts';

const NAME_WIDTH = 20;
const COUNT_WIDTH = 8;
const TOKEN_WIDTH = 8;
const COST_WIDTH = 11;
const CARD_WIDTH = 60;

/** Day header + token line, always rendered above the scrollable cards. */
export const DAY_DETAIL_HEADER_LINES = 2;

/** The role matching a cost's basis, so `$` and `~$` keep their colors. */
function costRole(cost: CostViewModel): 'spendCost' | 'quotaCost' {
  return cost.basis === 'spend' ? 'spendCost' : 'quotaCost';
}

function columnHeader(): RichLine {
  return joinLine(
    span(padEndWidth('model', NAME_WIDTH), 'tableHeader'),
    span(padStartWidth('prompts', COUNT_WIDTH), 'tableHeader'),
    span(padStartWidth('in', TOKEN_WIDTH), 'tableHeader'),
    span(padStartWidth('out', TOKEN_WIDTH), 'tableHeader'),
    span(padStartWidth('cost', COST_WIDTH), 'tableHeader'),
  );
}

function modelRow(row: BreakdownRowViewModel): RichLine {
  // one cost per row — the basis the row's data actually supports,
  // marked by its $/~$ prefix (see primaryCostViewModel)
  const cost = primaryCostViewModel(row.spendCost, row.quotaCost);
  return joinLine(
    span(padEndWidth(truncateToWidth(row.key, NAME_WIDTH), NAME_WIDTH)),
    span(padStartWidth(row.promptCount.toLocaleString('en-US'), COUNT_WIDTH)),
    span(padStartWidth(formatCompact(row.tokens.inputTokens), TOKEN_WIDTH), 'muted'),
    span(padStartWidth(formatCompact(row.tokens.outputTokens), TOKEN_WIDTH), 'muted'),
    span(padStartWidth(formatCostCell(cost), COST_WIDTH), costRole(cost)),
  );
}

function agentTitle(entry: DayAgentDetailViewModel): string {
  const agent = entry.agent;
  const prompts = `${agent.promptCount.toLocaleString('en-US')} prompt${agent.promptCount === 1 ? '' : 's'}`;
  return `${agent.key} · ${prompts} · ${formatCostCell(primaryCostViewModel(agent.spendCost, agent.quotaCost))}`;
}

/** One agent card with every model row; the view scrolls, so nothing folds. */
function agentCard(entry: DayAgentDetailViewModel, width: number): RichLine[] {
  const content: RichLine[] = [columnHeader()];
  if (entry.models.length === 0) {
    content.push(joinLine(span('no model rows recorded', 'muted')));
  } else {
    content.push(...entry.models.map(modelRow));
  }
  return renderCard({
    title: agentTitle(entry),
    content,
    width: Math.min(CARD_WIDTH, width - 2),
  }).map((line) => joinLine(' ', line));
}

/** Every agent-card line for the day, unclipped; the caller scrolls. */
export function dayDetailCardLines(
  detail: ResourceState<DayDetailViewModel>,
  width: number,
): RichLine[] {
  if (detail.data === null) {
    return [];
  }
  return detail.data.agents.flatMap((entry) => agentCard(entry, width));
}

/** Scroll offset clamped so the last page is always full when possible. */
export function clampDayDetailScroll(totalLines: number, scroll: number, windowRows: number): number {
  return Math.max(0, Math.min(scroll, totalLines - Math.max(1, windowRows)));
}

/**
 * The day header and token line always render; below them a window of
 * `cardRows` lines over the full card list, offset by `scroll`. The
 * chart above keeps its height — overflow scrolls instead of squeezing.
 */
export function renderDayDetail(
  point: DailyPointViewModel,
  detail: ResourceState<DayDetailViewModel>,
  width: number,
  cardRows: number,
  scroll = 0,
): RichLine[] {
  const cards = dayDetailCardLines(detail, width);
  const windowRows = Math.max(1, cardRows);
  const clamped = clampDayDetailScroll(cards.length, scroll, windowRows);
  const lines: RichLine[] = [];
  const prompts = `${point.promptCount.toLocaleString('en-US')} prompt${point.promptCount === 1 ? '' : 's'}`;
  // quota cost is always shown; spend earns its slot only when the day has
  // billed rows (the two never share a number)
  const headSpans = [
    span(` ▾ ${point.date}`, 'accent', { bold: true }),
    span(` · ${prompts}`, 'default'),
    span(' · quota ', 'muted'),
    span(formatCostCell(point.quotaCost), 'quotaCost'),
  ];
  if (point.spendCost.pricedRows > 0 || point.spendCost.unpricedRows > 0) {
    headSpans.push(span(' · spend ', 'muted'), span(formatCostCell(point.spendCost), 'spendCost'));
  }
  if (point.unknownRows > 0) {
    headSpans.push(span(` · ?${point.unknownRows.toLocaleString('en-US')} unclassified`, 'warning'));
  }
  headSpans.push(
    span(
      cards.length > windowRows
        ? `   ${clamped + 1}-${Math.min(cards.length, clamped + windowRows)}/${cards.length} · ↑↓ scroll · ←/→ day · Esc close`
        : '   ←/→ day · Esc close',
      'dim',
    ),
  );
  lines.push(joinLine(...headSpans));
  const tokens = point.tokens;
  lines.push(
    joinLine(
      span(
        `   in ${formatCompact(tokens.inputTokens)} · out ${formatCompact(tokens.outputTokens)}` +
          ` · cacheR ${formatCompact(tokens.cacheRead)} · cacheW ${formatCompact(tokens.cacheWrite)}` +
          ` · reason ${formatCompact(tokens.reasoningTokens)}`,
        'muted',
      ),
    ),
  );

  if (detail.data === null) {
    if (detail.phase === 'error') {
      lines.push(joinLine(span(` ! day breakdown failed: ${detail.error ?? 'unknown'}`, 'danger')));
    } else {
      lines.push(joinLine(span(' loading day breakdown…', 'muted')));
    }
    return lines;
  }
  if (detail.data.agents.length === 0) {
    lines.push(joinLine(span(' no usage recorded for this day', 'muted')));
    return lines;
  }
  lines.push(...cards.slice(clamped, clamped + windowRows));
  return lines;
}
