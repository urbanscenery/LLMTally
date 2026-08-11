import { renderCard } from './card.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import type { ConfirmOverlay, InputOverlay, NoticeOverlay, PickerOverlay } from '../overlay.ts';
import { padEndWidth, truncateToWidth, wrapToWidth } from '../text.ts';

const MAX_WIDTH = 64;
const MARKER = '▸ ';

function overlayWidth(width: number): number {
  return Math.max(20, Math.min(MAX_WIDTH, width - 4));
}

/** Centers a card body inside the available height. */
function center(lines: readonly RichLine[], height: number): RichLine[] {
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  return [...Array.from({ length: top }, (): RichLine => []), ...lines];
}

export function renderPickerOverlay(
  picker: PickerOverlay,
  width: number,
  height: number,
): RichLine[] {
  const cardWidth = overlayWidth(width);
  const inner = cardWidth - 4;
  const content: RichLine[] = [];
  picker.options.forEach((option, index) => {
    const selected = index === picker.index;
    const disabled = option.disabled === true;
    const hint = option.hint ?? '';
    const labelRoom = Math.max(4, inner - hint.length - MARKER.length - 1);
    const label = padEndWidth(truncateToWidth(option.label, labelRoom), labelRoom);
    content.push(
      joinLine(
        span(selected ? MARKER : '  ', selected ? 'selected' : 'default'),
        span(label, disabled ? 'dim' : selected ? 'selected' : 'default'),
        span(hint === '' ? '' : ` ${hint}`, 'muted'),
      ),
    );
  });
  content.push([]);
  content.push(joinLine(span('↑↓ move   Enter select   Esc cancel', 'muted')));
  return center(renderCard({ title: picker.title, content, width: cardWidth, active: true }), height);
}

/**
 * Messages in decision/result overlays must never be elided: what got
 * cut is exactly what the user needed to read (which account, why it
 * failed, what to do next). They wrap instead.
 */
function wrappedMessageLines(
  message: string,
  cardWidth: number,
  role: 'default' | 'accent',
): RichLine[] {
  const lines: RichLine[] = [];
  for (const raw of message.split('\n')) {
    for (const wrapped of wrapToWidth(raw, cardWidth - 4)) {
      lines.push(joinLine(span(wrapped, role)));
    }
  }
  return lines;
}

export function renderConfirmOverlay(
  confirm: ConfirmOverlay,
  width: number,
  height: number,
): RichLine[] {
  const cardWidth = overlayWidth(width);
  const content: RichLine[] = [
    ...wrappedMessageLines(confirm.message, cardWidth, 'default'),
    [],
    joinLine(span('y', 'key'), span(' confirm    ', 'muted'), span('n / Esc', 'key'), span(' cancel', 'muted')),
  ];
  return center(renderCard({ title: confirm.title, content, width: cardWidth, active: true }), height);
}

export function renderInputOverlay(
  input: InputOverlay,
  width: number,
  height: number,
): RichLine[] {
  const cardWidth = overlayWidth(width);
  const room = cardWidth - 6;
  // show the tail while typing so the caret is always visible
  const shown = input.value.length > room ? input.value.slice(input.value.length - room) : input.value;
  const content: RichLine[] = [
    joinLine(span(input.prompt, 'muted')),
    [],
    joinLine(span('> ', 'accent'), span(shown, 'default'), span('█', 'accent')),
    [],
    joinLine(span('Enter run   Esc cancel', 'muted')),
  ];
  return center(renderCard({ title: input.title, content, width: cardWidth, active: true }), height);
}

export function renderNoticeOverlay(
  notice: NoticeOverlay,
  width: number,
  height: number,
): RichLine[] {
  const cardWidth = overlayWidth(width);
  const content: RichLine[] = [
    ...wrappedMessageLines(notice.message, cardWidth, notice.busy ? 'accent' : 'default'),
  ];
  content.push([]);
  content.push(
    joinLine(span(notice.busy ? 'working…' : 'Enter / Esc close', 'muted')),
  );
  return center(renderCard({ title: notice.title, content, width: cardWidth, active: true }), height);
}
