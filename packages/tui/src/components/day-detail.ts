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
/** Borders and the column header before the first model row. */
const CARD_CHROME_LINES = 3;

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

/** One agent card; `contentRows` is the model-row budget (≥ 1). */
function agentCard(entry: DayAgentDetailViewModel, width: number, contentRows: number): RichLine[] {
  const content: RichLine[] = [columnHeader()];
  if (entry.models.length === 0) {
    content.push(joinLine(span('no model rows recorded', 'muted')));
  } else if (entry.models.length <= contentRows) {
    content.push(...entry.models.map(modelRow));
  } else {
    // the "more" marker takes one of the budgeted rows
    const shown = Math.max(1, contentRows - 1);
    content.push(...entry.models.slice(0, shown).map(modelRow));
    content.push(joinLine(span(`… +${entry.models.length - shown} more models`, 'dim')));
  }
  return renderCard({
    title: agentTitle(entry),
    content,
    width: Math.min(CARD_WIDTH, width - 2),
  }).map((line) => joinLine(' ', line));
}

/**
 * Renders at most `maxLines` lines. The day header always fits first;
 * agent cards follow busiest-first until the budget runs out, and a
 * card only renders when at least one of its model rows fits.
 */
export function renderDayDetail(
  point: DailyPointViewModel,
  detail: ResourceState<DayDetailViewModel>,
  width: number,
  maxLines: number,
): RichLine[] {
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
  headSpans.push(span('   ←/→ day · Esc close', 'dim'));
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

  let remaining = maxLines - lines.length;
  if (remaining <= 0) {
    return lines.slice(0, Math.max(0, maxLines));
  }
  if (detail.data === null) {
    if (detail.phase === 'error') {
      lines.push(joinLine(span(` ! day breakdown failed: ${detail.error ?? 'unknown'}`, 'danger')));
    } else {
      lines.push(joinLine(span(' loading day breakdown…', 'muted')));
    }
    return lines;
  }

  const agents = detail.data.agents;
  if (agents.length === 0) {
    lines.push(joinLine(span(' no usage recorded for this day', 'muted')));
    return lines;
  }
  for (const [index, entry] of agents.entries()) {
    const minCard = CARD_CHROME_LINES + 1;
    if (remaining < minCard) {
      const hidden = agents.length - index;
      if (remaining >= 1 && hidden > 0) {
        lines.push(joinLine(span(` … +${hidden} more agent${hidden === 1 ? '' : 's'}`, 'dim')));
      }
      break;
    }
    // fair share of the remaining lines, so a model-heavy first agent
    // cannot push the ones after it off the screen entirely
    const budget = Math.max(minCard, Math.floor(remaining / (agents.length - index)));
    const contentRows = Math.min(
      Math.max(1, budget - CARD_CHROME_LINES),
      Math.max(1, entry.models.length),
    );
    const card = agentCard(entry, width, contentRows);
    lines.push(...card);
    remaining -= card.length;
  }
  return lines.slice(0, maxLines);
}
