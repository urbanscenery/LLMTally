import { fitRichLine, joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import { displayWidth, truncateToWidth } from '../text.ts';

export const CARD_MIN_WIDTH = 32;

export interface CardOptions {
  readonly title?: string;
  readonly content: readonly RichLine[];
  readonly width: number;
  readonly active?: boolean;
}

/**
 * superfile-style rounded card with the title embedded in the top
 * border. Below CARD_MIN_WIDTH the border is dropped entirely and the
 * content renders bare — degraded, never broken.
 */
export function renderCard(options: CardOptions): RichLine[] {
  const { content, width } = options;
  if (width < CARD_MIN_WIDTH) {
    const lines: RichLine[] = [];
    if (options.title !== undefined) {
      lines.push(fitRichLine(joinLine(span(` ${options.title}`, 'tableHeader')), width));
    }
    lines.push(...content.map((line) => fitRichLine(joinLine(' ', line), width)));
    return lines;
  }

  const borderRole = options.active === true ? 'accent' : 'border';
  const inner = width - 2;
  // titles come from data (agent/plan names) — cap them to the frame
  const title =
    options.title === undefined ? undefined : truncateToWidth(options.title, inner - 4);
  const top =
    title === undefined
      ? joinLine(span(`╭${'─'.repeat(inner)}╮`, borderRole))
      : joinLine(
          span('╭─ ', borderRole),
          span(title, 'accent', { bold: true }),
          span(` ${'─'.repeat(Math.max(0, inner - displayWidth(title) - 3))}`, borderRole),
          span('╮', borderRole),
        );
  return [
    top,
    ...content.map((line) =>
      joinLine(span('│', borderRole), fitRichLine(joinLine(' ', line), inner), span('│', borderRole)),
    ),
    joinLine(span(`╰${'─'.repeat(inner)}╯`, borderRole)),
  ];
}

/** Places two equally tall blocks side by side (pads the shorter one). */
export function joinColumns(
  left: readonly RichLine[],
  right: readonly RichLine[],
  leftWidth: number,
  gap = 2,
): RichLine[] {
  const rows = Math.max(left.length, right.length);
  const lines: RichLine[] = [];
  for (let index = 0; index < rows; index += 1) {
    lines.push(
      joinLine(fitRichLine(left[index] ?? [], leftWidth), ' '.repeat(gap), right[index] ?? []),
    );
  }
  return lines;
}
