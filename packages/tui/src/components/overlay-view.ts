import { renderCard } from './card.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import type { ConfirmOverlay, InputOverlay, NoticeOverlay, PickerOverlay } from '../overlay.ts';
import { displayWidth, padEndWidth, wrapToWidth } from '../text.ts';

const MAX_WIDTH = 64;
const MARKER = '▸ ';
/** Rows the card frame adds around its content (top + bottom border). */
const FRAME_ROWS = 2;
const PICKER_HINT = '↑↓ move   Enter select   Esc cancel';

function maxCardWidth(width: number): number {
  return Math.max(20, width - 4);
}

/** Centers a card body inside the available height. */
function center(lines: readonly RichLine[], height: number): RichLine[] {
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  return [...Array.from({ length: top }, (): RichLine => []), ...lines];
}

/**
 * Lays the content out at the preferred width, then widens the card and
 * finally drops the frame when the terminal is too short — the message
 * must stay complete; only the chrome may give (the shell crops
 * whatever a view returns beyond the body height).
 */
function fitMessageCard(
  title: string,
  buildContent: (textWidth: number) => RichLine[],
  width: number,
  height: number,
): RichLine[] {
  const widest = maxCardWidth(width);
  let cardWidth = Math.min(MAX_WIDTH, widest);
  let content = buildContent(cardWidth - 4);
  while (content.length + FRAME_ROWS > height && cardWidth < widest) {
    cardWidth = Math.min(widest, cardWidth + 8);
    content = buildContent(cardWidth - 4);
  }
  if (content.length + FRAME_ROWS <= height) {
    return center(renderCard({ title, content, width: cardWidth, active: true }), height);
  }
  // still too tall: spend the frame's rows and side margins on the text
  return [
    joinLine(span(` ${title}`, 'accent', { bold: true })),
    ...buildContent(Math.max(16, width - 2)).map((line) => joinLine(' ', line)),
  ];
}

export function renderPickerOverlay(
  picker: PickerOverlay,
  width: number,
  height: number,
): RichLine[] {
  // the card grows to the longest option — labels and hints are data
  // (account names, caveats) and must not be elided
  const longestRow = picker.options.reduce((widest, option) => {
    const hint = option.hint ?? '';
    const row =
      MARKER.length + displayWidth(option.label) + (hint === '' ? 0 : displayWidth(hint) + 1);
    return Math.max(widest, row);
  }, displayWidth(PICKER_HINT));
  const cardWidth = Math.max(
    20,
    Math.min(Math.max(MAX_WIDTH, longestRow + 4), maxCardWidth(width)),
  );
  const inner = cardWidth - 4;
  const content: RichLine[] = [];
  picker.options.forEach((option, index) => {
    const selected = index === picker.index;
    const disabled = option.disabled === true;
    const hint = option.hint ?? '';
    const labelRoom = Math.max(4, inner - displayWidth(hint) - MARKER.length - (hint === '' ? 0 : 1));
    const label = padEndWidth(option.label, labelRoom);
    content.push(
      joinLine(
        span(selected ? MARKER : '  ', selected ? 'selected' : 'default'),
        span(label, disabled ? 'dim' : selected ? 'selected' : 'default'),
        span(hint === '' ? '' : ` ${hint}`, 'muted'),
      ),
    );
  });
  content.push([]);
  content.push(joinLine(span(PICKER_HINT, 'muted')));
  return center(renderCard({ title: picker.title, content, width: cardWidth, active: true }), height);
}

/**
 * Messages in decision/result overlays must never be elided: what got
 * cut is exactly what the user needed to read (which account, why it
 * failed, what to do next). They wrap instead.
 */
function wrappedMessageLines(
  message: string,
  textWidth: number,
  role: 'default' | 'accent' | 'muted',
): RichLine[] {
  const lines: RichLine[] = [];
  for (const raw of message.split('\n')) {
    for (const wrapped of wrapToWidth(raw, textWidth)) {
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
  return fitMessageCard(
    confirm.title,
    (textWidth) => [
      ...wrappedMessageLines(confirm.message, textWidth, 'default'),
      [],
      joinLine(span('y', 'key'), span(' confirm    ', 'muted'), span('n / Esc', 'key'), span(' cancel', 'muted')),
    ],
    width,
    height,
  );
}

export function renderInputOverlay(
  input: InputOverlay,
  width: number,
  height: number,
): RichLine[] {
  return fitMessageCard(
    input.title,
    (textWidth) => {
      const room = textWidth - 2;
      // show the tail while typing so the caret is always visible
      const shown =
        input.value.length > room ? input.value.slice(input.value.length - room) : input.value;
      return [
        ...wrappedMessageLines(input.prompt, textWidth, 'muted'),
        [],
        joinLine(span('> ', 'accent'), span(shown, 'default'), span('█', 'accent')),
        [],
        joinLine(span('Enter run   Esc cancel', 'muted')),
      ];
    },
    width,
    height,
  );
}

export function renderNoticeOverlay(
  notice: NoticeOverlay,
  width: number,
  height: number,
): RichLine[] {
  return fitMessageCard(
    notice.title,
    (textWidth) => [
      ...wrappedMessageLines(notice.message, textWidth, notice.busy ? 'accent' : 'default'),
      [],
      joinLine(span(notice.busy ? 'working…' : 'Enter / Esc close', 'muted')),
    ],
    width,
    height,
  );
}
