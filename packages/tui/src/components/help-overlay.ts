import { helpGroups } from '../keybindings.ts';
import { renderCard } from './card.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichFrame, RichLine } from '../rich-text.ts';
import { padEndWidth } from '../text.ts';

const OVERLAY_WIDTH = 46;
const KEY_COLUMN = 15;

/**
 * lazygit-style '?' cheatsheet as a centered modal card. Returned as a
 * full-height frame overlaying the body region; the caller composes it.
 */
export function renderHelpOverlay(width: number, height: number): RichFrame {
  const cardWidth = Math.min(OVERLAY_WIDTH, Math.max(24, width - 4));

  const content: RichLine[] = [];
  for (const [group, bindings] of helpGroups()) {
    content.push(joinLine(span(group, 'accent', { bold: true })));
    for (const binding of bindings) {
      content.push(
        joinLine(
          span(padEndWidth(binding.keysLabel, KEY_COLUMN), 'key'),
          span(binding.label, 'muted'),
        ),
      );
    }
    content.push([]);
  }
  while (content.length > 0 && content[content.length - 1]?.length === 0) {
    content.pop();
  }

  const boxed = renderCard({ title: 'Help', content, width: cardWidth, active: true });

  // center inside the body region
  const topPad = Math.max(0, Math.floor((height - boxed.length) / 2));
  const leftPad = Math.max(0, Math.floor((width - cardWidth) / 2));
  const frame: RichLine[] = [];
  for (let row = 0; row < height; row += 1) {
    const boxRow = row - topPad;
    if (boxRow >= 0 && boxRow < boxed.length) {
      frame.push(joinLine(' '.repeat(leftPad), boxed[boxRow] ?? []));
    } else {
      frame.push([]);
    }
  }
  return frame;
}
