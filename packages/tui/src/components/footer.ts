import { footerBindings } from '../keybindings.ts';
import { autoIntervalLabel } from '../refresh.ts';
import { joinLine, lineWidth, span, truncateRichLine } from '../rich-text.ts';
import { displayWidth } from '../text.ts';
import type { RichLine, StyledSpan } from '../rich-text.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import type { TuiState } from '../state.ts';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Advances on every re-render tick (no dedicated timer, no idle CPU). */
function spinnerFrame(nowUtc: number): string {
  return SPINNER_FRAMES[Math.abs(nowUtc) % SPINNER_FRAMES.length] ?? '⠋';
}

/**
 * Hints come from the shared keybinding registry; when space runs out
 * the lowest-priority hints drop first (lazygit-style).
 */
function keyHints(state: TuiState, maxWidth: number): RichLine {
  const spans: StyledSpan[] = [];
  let used = 0;
  for (const binding of footerBindings(state)) {
    const hint = binding.footer!;
    const hintWidth =
      displayWidth(hint.keys) + displayWidth(hint.text) + (spans.length > 0 ? 2 : 0);
    if (used + hintWidth > maxWidth) {
      break;
    }
    if (spans.length > 0) {
      spans.push({ text: '  ' });
    }
    spans.push({ text: hint.keys, role: 'key' }, { text: hint.text });
    used += hintWidth;
  }
  return spans;
}

function describeScanStatus(state: TuiState, nowUtc: number): RichLine {
  switch (state.refresh.scanStatus) {
    case 'running':
      return joinLine(span(`${spinnerFrame(nowUtc)} refreshing…`, 'accent'));
    case 'busy':
      return joinLine(span('scan busy (daemon)', 'warning'));
    case 'error':
      return joinLine(span('refresh error', 'danger'));
    default:
      return [];
  }
}

function describeUpdated(state: TuiState, nowUtc: number): string {
  const auto = `auto ${autoIntervalLabel(state.refresh.autoIntervalSeconds)}`;
  const last = state.refresh.lastCompletedAtUtc;
  if (last === null) {
    return `local • ${auto} • not refreshed yet`;
  }
  const age = Math.max(0, nowUtc - last);
  const text = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
  return `local • ${auto} • updated ${text} ago`;
}

/**
 * One-line footer: key hints left, scan status + freshness right. The
 * right side is laid out first; hints get whatever width remains and
 * drop lowest-priority-first, so status text never truncates.
 */
export function buildFooterLine(state: TuiState, width: number, nowUtc: number): RichLine {
  const status = describeScanStatus(state, nowUtc);
  const updated = span(sanitizeTerminalLine(describeUpdated(state, nowUtc)), 'muted');
  const right = status.length === 0 ? joinLine(updated) : joinLine(status, span(' | ', 'dim'), updated);
  const hints = keyHints(state, Math.max(10, width - lineWidth(right) - 2));
  const gap = width - lineWidth(hints) - lineWidth(right);
  if (gap < 1) {
    return truncateRichLine(joinLine(hints, '  ', right), width);
  }
  return joinLine(hints, ' '.repeat(gap), right);
}
