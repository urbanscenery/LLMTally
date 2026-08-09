/** Width-aware line helpers shared by all TUI views (terminal cells, not code units). */

export function displayWidth(value: string): number {
  return Bun.stringWidth(value);
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Truncates to `width` terminal cells, appending `…` when cut.
 * Iterates grapheme clusters so ZWJ emoji and combining marks are
 * never split in the middle.
 */
export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (displayWidth(value) <= width) {
    return value;
  }
  let out = '';
  for (const { segment } of GRAPHEMES.segment(value)) {
    if (displayWidth(out + segment) > width - 1) {
      break;
    }
    out += segment;
  }
  return `${out}…`;
}

/** Pads or truncates so the line occupies exactly `width` cells. */
export function fitLine(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return truncated + ' '.repeat(Math.max(0, width - displayWidth(truncated)));
}

export function padEndWidth(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

export function padStartWidth(value: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(value))) + value;
}
