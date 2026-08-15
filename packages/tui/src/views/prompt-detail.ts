import type { TokenTotals } from '@llmtally/core/pricing/types.ts';
import { formatCompact } from '../format.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine, ThemeRole } from '../rich-text.ts';
import { fitLine, padEndWidth, padStartWidth, truncateToWidth, wrapToWidth } from '../text.ts';
import type { PromptDetailState } from '../state.ts';
import type { PromptCallViewModel, PromptDetailViewModel } from '../view-model/prompt-detail.ts';
import type { TabViewLine } from './shell.ts';

/** Header rows the detail view always draws before its scrollable body. */
export const PROMPT_DETAIL_HEADER_LINES = 2;
const LABEL_WIDTH = 10;
const CALL_TIME_WIDTH = 21;
const CALL_MODEL_WIDTH = 24;
const CALL_NUMBER_WIDTH = 9;
const CALL_COST_WIDTH = 12;
/** More calls than this are summarised — the body matters more than a wall of rows. */
const MAX_CALL_ROWS = 20;
const TEXT_INDENT = 2;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

function localDateTime(tsUtc: number): string {
  const date = new Date(tsUtc * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ${seconds % SECONDS_PER_MINUTE}s`;
  }
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${hours}h ${minutes}m`;
}

/** `$` spend, `~$` quota, `?$` unclassified — the same prefixes as every list. */
function costText(costUsd: number | null, nature: PromptDetailViewModel['nature']): {
  readonly text: string;
  readonly role: ThemeRole;
} {
  if (costUsd === null) {
    return { text: '— (unpriced)', role: 'muted' };
  }
  const amount = costUsd.toFixed(4);
  if (nature === 'spend') {
    return { text: `$${amount}`, role: 'spendCost' };
  }
  if (nature === 'quota') {
    return { text: `~$${amount} quota cost`, role: 'quotaCost' };
  }
  return { text: `?$${amount} unclassified`, role: 'muted' };
}

function fact(label: string, value: string, role: ThemeRole = 'default'): RichLine {
  return joinLine(' ', span(padEndWidth(label, LABEL_WIDTH), 'muted'), span(value, role));
}

function tokenFacts(tokens: TokenTotals): RichLine[] {
  const cell = (name: string, value: number): string =>
    `${name} ${value.toLocaleString('en-US')}`;
  return [
    fact('tokens', [cell('input', tokens.inputTokens), cell('output', tokens.outputTokens)].join('   ')),
    fact(
      '',
      [
        cell('cache read', tokens.cacheRead),
        cell('cache write', tokens.cacheWrite),
        cell('reasoning', tokens.reasoningTokens),
      ].join('   '),
    ),
  ];
}

function callRow(call: PromptCallViewModel, nature: PromptDetailViewModel['nature']): RichLine {
  const cost = costText(call.costUsd, nature);
  const costCell = call.costUsd === null ? '—' : cost.text.split(' ')[0] ?? cost.text;
  return joinLine(
    '   ',
    span(padEndWidth(localDateTime(call.tsUtc), CALL_TIME_WIDTH), 'muted'),
    span(padEndWidth(truncateToWidth(call.model, CALL_MODEL_WIDTH), CALL_MODEL_WIDTH)),
    span(padStartWidth(formatCompact(call.tokens.inputTokens), CALL_NUMBER_WIDTH), 'muted'),
    span(padStartWidth(formatCompact(call.tokens.outputTokens), CALL_NUMBER_WIDTH), 'muted'),
    span(padStartWidth(formatCompact(call.tokens.cacheRead), CALL_NUMBER_WIDTH), 'muted'),
    span(padStartWidth(formatCompact(call.tokens.cacheWrite), CALL_NUMBER_WIDTH), 'muted'),
    span(padStartWidth(costCell, CALL_COST_WIDTH), cost.role),
  );
}

function callsSection(model: PromptDetailViewModel): RichLine[] {
  const header = joinLine(
    '   ',
    span(padEndWidth('time', CALL_TIME_WIDTH), 'tableHeader'),
    span(padEndWidth('model', CALL_MODEL_WIDTH), 'tableHeader'),
    span(padStartWidth('in', CALL_NUMBER_WIDTH), 'tableHeader'),
    span(padStartWidth('out', CALL_NUMBER_WIDTH), 'tableHeader'),
    span(padStartWidth('cacheR', CALL_NUMBER_WIDTH), 'tableHeader'),
    span(padStartWidth('cacheW', CALL_NUMBER_WIDTH), 'tableHeader'),
    span(padStartWidth('cost', CALL_COST_WIDTH), 'tableHeader'),
  );
  const shown = model.calls.slice(0, MAX_CALL_ROWS);
  const lines: RichLine[] = [
    joinLine(' ', span(`calls (${model.calls.length})`, 'accent', { bold: true })),
    header,
    ...shown.map((call) => callRow(call, model.nature)),
  ];
  if (model.calls.length > shown.length) {
    lines.push(joinLine('   ', span(`… ${model.calls.length - shown.length} more calls`, 'muted')));
  }
  return lines;
}

function bodySection(model: PromptDetailViewModel, width: number): RichLine[] {
  const title = joinLine(' ', span('prompt', 'accent', { bold: true }));
  if (model.textLines.length === 0) {
    return [title, joinLine(' '.repeat(TEXT_INDENT + 1), span('(no prompt text stored)', 'dim'))];
  }
  const textWidth = Math.max(10, width - TEXT_INDENT - 1);
  const wrapped = model.textLines.flatMap((line) =>
    (line.length === 0 ? [''] : wrapToWidth(line, textWidth)).map(
      (piece): RichLine => joinLine(' '.repeat(TEXT_INDENT + 1), span(piece)),
    ),
  );
  return [title, ...wrapped];
}

/** Every line of the detail, unclipped; the caller scrolls through them. */
export function promptDetailLines(model: PromptDetailViewModel, width: number): RichLine[] {
  const cost = costText(model.costUsd, model.nature);
  const duration = model.lastTsUtc - model.firstTsUtc;
  const when = duration > 0
    ? `${localDateTime(model.firstTsUtc)}  →  ${localDateTime(model.lastTsUtc)}  (${formatDuration(duration)})`
    : localDateTime(model.firstTsUtc);
  const lines: RichLine[] = [
    fact('agent', model.provider === null ? model.agent : `${model.agent} (${model.provider})`),
    fact('model', model.effort === null ? model.model : `${model.model} · effort ${model.effort}`),
    fact('when', when),
    fact('calls', `${model.calls.length} API call${model.calls.length === 1 ? '' : 's'}${model.isSidechain ? ' · subagent prompt' : ''}`),
    ...tokenFacts(model.tokens),
    fact('cost', cost.text, cost.role),
  ];
  if (model.sessionId !== null) {
    lines.push(fact('session', model.sessionId));
  }
  if (model.cwd !== null) {
    lines.push(fact('cwd', model.cwd));
  }
  // the words first — they are what the user opened the page for; the
  // per-call table can run long and follows
  lines.push([], ...bodySection(model, width), [], ...callsSection(model));
  for (const warning of model.warnings) {
    lines.push(joinLine(' ', span(`! ${warning}`, 'warning')));
  }
  return lines;
}

export interface PromptDetailRenderOptions {
  readonly model: PromptDetailViewModel;
  readonly scroll: number;
  readonly width: number;
  readonly height: number;
  /** Where Esc leads back to, e.g. "back to prompts". */
  readonly backLabel: string;
}

/** Scroll offset clamped so the last page is always full when possible. */
export function clampDetailScroll(totalLines: number, scroll: number, bodyHeight: number): number {
  return Math.max(0, Math.min(scroll, totalLines - Math.max(1, bodyHeight)));
}

export function renderPromptDetail(options: PromptDetailRenderOptions): {
  readonly lines: TabViewLine[];
  readonly scroll: number;
  readonly totalLines: number;
} {
  const { model, width, height } = options;
  const all = promptDetailLines(model, width);
  const bodyHeight = Math.max(1, height - PROMPT_DETAIL_HEADER_LINES);
  const scroll = clampDetailScroll(all.length, options.scroll, bodyHeight);
  const position = all.length > bodyHeight
    ? `  ${scroll + 1}-${Math.min(all.length, scroll + bodyHeight)} of ${all.length} lines · ↑↓ scroll`
    : '';
  const header: TabViewLine[] = [
    joinLine(' ', span('Esc', 'key'), span(` ${options.backLabel}`, 'muted'), span(position, 'dim')),
    '',
  ];
  const visible = all.slice(scroll, scroll + bodyHeight).map((line) =>
    line.length === 0 ? '' : line,
  );
  return { lines: [...header, ...visible], scroll, totalLines: all.length };
}

/** Plain fallback lines while the detail loads or when it failed. */
export function promptDetailPlaceholder(message: string, width: number, backLabel: string): TabViewLine[] {
  return [
    joinLine(' ', span('Esc', 'key'), span(` ${backLabel}`, 'muted')),
    '',
    fitLine(`  ${message}`, width),
  ];
}

/** The page for an open detail state: loading / error placeholder or the rendered detail. */
export function promptDetailView(
  detail: PromptDetailState,
  width: number,
  height: number,
  backLabel: string,
): TabViewLine[] {
  const { resource } = detail;
  if (resource.data === null) {
    const message = resource.phase === 'error'
      ? `prompt unavailable: ${resource.error ?? 'unknown error'}`
      : 'loading prompt…';
    return promptDetailPlaceholder(message, width, backLabel);
  }
  return renderPromptDetail({ model: resource.data, scroll: detail.scroll, width, height, backLabel }).lines;
}
