import { formatCompact } from '../format.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import { fitLine, padEndWidth, padStartWidth, truncateToWidth } from '../text.ts';
import type { PromptRowViewModel, PromptsViewModel } from '../view-model/prompts.ts';
import type { TabViewLine } from './shell.ts';

/** Two lines per entry keeps the mapping from screen row to entry exact. */
export const LINES_PER_PROMPT = 2;
/** Header ("scope" line + blank) rendered before the first entry. */
export const PROMPT_LIST_HEADER_LINES = 2;

/**
 * First entry drawn for a given cursor and available height. Rendering
 * and hit-testing both call this so a click always resolves to the
 * entry the user sees under the pointer.
 */
export function promptWindowStart(rowCount: number, cursor: number, listHeight: number): {
  readonly firstVisible: number;
  readonly room: number;
} {
  const room = Math.max(1, Math.floor(listHeight / LINES_PER_PROMPT));
  if (rowCount === 0) {
    return { firstVisible: 0, room };
  }
  const clamped = Math.max(0, Math.min(cursor, rowCount - 1));
  return {
    firstVisible: Math.max(0, Math.min(clamped - Math.floor(room / 2), rowCount - room)),
    room,
  };
}

/** Entry index under a body row, or null when the row is not an entry. */
export function promptIndexAtLine(
  firstVisible: number,
  rowsAbove: number,
  bodyRow: number,
  rowCount: number,
): number | null {
  const offset = bodyRow - rowsAbove - PROMPT_LIST_HEADER_LINES;
  if (offset < 0) {
    return null;
  }
  const index = firstVisible + Math.floor(offset / LINES_PER_PROMPT);
  return index < rowCount ? index : null;
}
const TIME_WIDTH = 16;
const TOKENS_WIDTH = 26;
const COST_WIDTH = 11;
const CALLS_WIDTH = 6;

function localTimestamp(tsUtc: number): string {
  const date = new Date(tsUtc * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** The prefix says how the row settles: `$` spend, `~$` quota, `?$` unclassified. */
function costCell(row: PromptRowViewModel): { text: string; role: 'spendCost' | 'quotaCost' | 'muted' } {
  if (row.costUsd === null) {
    return { text: '—', role: 'muted' };
  }
  if (row.nature === 'spend') {
    return { text: `$${row.costUsd.toFixed(4)}`, role: 'spendCost' };
  }
  if (row.nature === 'quota') {
    return { text: `~$${row.costUsd.toFixed(4)}`, role: 'quotaCost' };
  }
  return { text: `?$${row.costUsd.toFixed(4)}`, role: 'muted' };
}

function tokensCell(row: PromptRowViewModel): string {
  const parts = [`in ${formatCompact(row.inputTokens)}`, `out ${formatCompact(row.outputTokens)}`];
  if (row.cacheRead > 0) {
    parts.push(`cR ${formatCompact(row.cacheRead)}`);
  }
  return parts.join(' ');
}

/** `×N` says how many API calls the prompt took; a lone call shows nothing. */
function callsCell(row: PromptRowViewModel): string {
  return row.calls > 1 ? `×${row.calls}` : '';
}

/** Subagent prompts are marked so the user's own prompts stand out. */
function sidechainMark(row: PromptRowViewModel): string {
  return row.isSidechain ? '↳ ' : '';
}

export function promptEntryLines(
  row: PromptRowViewModel,
  selected: boolean,
  width: number,
): RichLine[] {
  const cost = costCell(row);
  const meta = joinLine(
    span(selected ? '▸ ' : '  ', selected ? 'selected' : 'default'),
    span(padEndWidth(localTimestamp(row.tsUtc), TIME_WIDTH), 'muted'),
    span(padEndWidth(truncateToWidth(row.model, 26), 26), selected ? 'selected' : 'default'),
    span(padEndWidth(tokensCell(row), TOKENS_WIDTH), 'muted'),
    span(padStartWidth(cost.text, COST_WIDTH), cost.role),
    span(padStartWidth(callsCell(row), CALLS_WIDTH), 'muted'),
  );
  const indent = 4;
  const mark = sidechainMark(row);
  const body = joinLine(
    span(' '.repeat(indent)),
    span(mark, 'muted'),
    span(
      truncateToWidth(row.text === '' ? '(no prompt text stored)' : row.text, Math.max(10, width - indent - mark.length - 1)),
      row.text === '' ? 'dim' : 'default',
    ),
  );
  return [meta, body];
}

export interface PromptsRenderOptions {
  readonly model: PromptsViewModel;
  readonly cursor: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Renders a window of entries around the cursor so a long list stays
 * navigable without a scrollback buffer, and reports the first visible
 * index so clicks can be mapped back to entries.
 */
export function renderPromptList(options: PromptsRenderOptions): {
  readonly lines: TabViewLine[];
  readonly firstVisible: number;
} {
  const { model, width, height } = options;
  const header = joinLine(
    ' ',
    span(model.scope, 'tableHeader'),
    span(`  ${model.rows.length} prompt(s)${model.truncated ? '+' : ''}`, 'muted'),
    span('  · Enter opens details', 'dim'),
  );
  const lines: TabViewLine[] = [header, ''];
  if (model.rows.length === 0) {
    lines.push(fitLine('  no prompts matched', width));
    return { lines, firstVisible: 0 };
  }
  const cursor = Math.max(0, Math.min(options.cursor, model.rows.length - 1));
  const { firstVisible, room } = promptWindowStart(
    model.rows.length,
    cursor,
    height - PROMPT_LIST_HEADER_LINES - model.warnings.length,
  );
  const visible = model.rows.slice(firstVisible, firstVisible + room);
  visible.forEach((row, offset) => {
    lines.push(...promptEntryLines(row, firstVisible + offset === cursor, width));
  });
  for (const warning of model.warnings) {
    lines.push(joinLine(' ', span(`! ${warning}`, 'warning')));
  }
  return { lines, firstVisible };
}
