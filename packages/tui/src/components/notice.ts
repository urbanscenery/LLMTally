import { joinLine, span } from '../rich-text.ts';
import type { RichLine, ThemeRole } from '../rich-text.ts';
import { displayWidth, wrapToWidth } from '../text.ts';

/** Narrowest text column a notice will wrap to before giving up on width. */
const MIN_NOTICE_TEXT_WIDTH = 8;

/**
 * A warning, error, or recovery instruction the user must be able to
 * read in full. Never elided: the text wraps to `width`, the marker
 * (`! `, `⚠ `, `  ! `) leads the first line and continuation lines are
 * indented under the text so the block reads as one notice.
 */
export function noticeLines(
  marker: string,
  text: string,
  width: number,
  role: ThemeRole,
): RichLine[] {
  const markerWidth = displayWidth(marker);
  const indent = ' '.repeat(markerWidth);
  const textWidth = Math.max(MIN_NOTICE_TEXT_WIDTH, width - markerWidth);
  return wrapToWidth(text, textWidth).map(
    (line, index): RichLine => joinLine(span(`${index === 0 ? marker : indent}${line}`, role)),
  );
}
