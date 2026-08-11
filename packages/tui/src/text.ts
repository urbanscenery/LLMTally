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

/**
 * Wraps to lines of at most `width` cells, breaking at spaces and only
 * splitting inside a word when the word alone exceeds the width. Never
 * drops content — the counterpart to `truncateToWidth` for text that
 * must stay fully readable (error messages, confirmations).
 */
export function wrapToWidth(value: string, width: number): string[] {
  if (width <= 0 || displayWidth(value) <= width) {
    return [value];
  }
  const lines: string[] = [];
  let current = '';
  for (const word of value.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      lines.push(current);
      current = '';
    }
    if (displayWidth(word) <= width) {
      current = word;
      continue;
    }
    // a single token wider than the line: hard-break by grapheme
    let piece = '';
    for (const { segment } of GRAPHEMES.segment(word)) {
      if (displayWidth(piece + segment) > width) {
        lines.push(piece);
        piece = segment;
      } else {
        piece += segment;
      }
    }
    current = piece;
  }
  lines.push(current);
  return lines;
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
