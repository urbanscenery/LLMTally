import { formatCompact } from '../format.ts';
import { rampIndex } from '../gradient.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine, StyledSpan } from '../rich-text.ts';
import { displayWidth, padStartWidth } from '../text.ts';
import type { DailyPointViewModel } from '../view-model/overview.ts';

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const AXIS_WIDTH = 7;

export type ChartGlyphMode = 'block' | 'braille';

/**
 * btop-style braille packing: one cell carries two samples as 0..4 dot
 * columns (left bits 0x40|0x44|…, right 0x80|0xa0|…), so a braille
 * chart shows 2x the days of the block chart in the same width.
 */
const BRAILLE_LEFT = [0x00, 0x40, 0x44, 0x46, 0x47] as const;
const BRAILLE_RIGHT = [0x00, 0x80, 0xa0, 0xb0, 0xb8] as const;

function brailleGlyph(leftHeight: number, rightHeight: number): string {
  return String.fromCodePoint(
    0x2800 | (BRAILLE_LEFT[leftHeight] ?? 0) | (BRAILLE_RIGHT[rightHeight] ?? 0),
  );
}

/** Sub-cell level (0..levels) of `value` inside one chart row. */
function rowLevel(value: number, max: number, row: number, height: number, levels: number): number {
  if (max === 0) {
    return 0;
  }
  const scaled = (value / max) * height * levels;
  const rowFromBottom = height - 1 - row;
  return Math.min(levels, Math.max(0, Math.round(scaled - rowFromBottom * levels)));
}

function chartRole(row: number, height: number): StyledSpan['role'] {
  // btop colors by vertical position: hotter toward the top
  const percent = rampIndex(((height - row) / height) * 100);
  return `ramp:chart:${percent}`;
}

/**
 * Pure vertical chart. Shows the most recent points that fit the
 * width (block: 1 point per 2 cells; braille: 2 points per cell). A
 * flat zero series renders an empty plot without dividing by zero.
 * Output is exactly `height` rows plus one date-axis row.
 */
export function renderDailyBlockChart(
  points: readonly DailyPointViewModel[],
  width: number,
  height: number,
  mode: ChartGlyphMode = 'block',
): RichLine[] {
  const plotHeight = Math.max(1, height);
  const plotCells = Math.max(1, width - AXIS_WIDTH - 1);
  const visible =
    mode === 'braille'
      ? points.slice(-(plotCells * 2))
      : points.slice(-Math.max(1, Math.floor(plotCells / 2)));
  const max = visible.reduce((acc, point) => Math.max(acc, point.value), 0);

  const rows: RichLine[] = [];
  for (let row = 0; row < plotHeight; row += 1) {
    const cells: string[] = [];
    if (mode === 'braille') {
      // odd sample counts get a zero prepended so dates stay in order
      const samples = visible.length % 2 === 1 ? [null, ...visible] : [...visible];
      for (let index = 0; index < samples.length; index += 2) {
        const left = samples[index];
        const right = samples[index + 1];
        cells.push(
          brailleGlyph(
            left ? rowLevel(left.value, max, row, plotHeight, 4) : 0,
            right ? rowLevel(right.value, max, row, plotHeight, 4) : 0,
          ),
        );
      }
    } else {
      for (const point of visible) {
        const level = rowLevel(point.value, max, row, plotHeight, 8);
        cells.push(`${EIGHTHS[level] ?? ' '} `);
      }
    }
    const axisLabel =
      row === 0 ? padStartWidth(formatCompact(max), AXIS_WIDTH - 1) : ' '.repeat(AXIS_WIDTH - 1);
    rows.push(
      joinLine(
        span(axisLabel, 'muted'),
        span('│', 'border'),
        span(cells.join('').trimEnd(), chartRole(row, plotHeight)),
      ),
    );
  }

  const first = visible[0]?.date ?? '';
  const last = visible.length > 1 ? (visible[visible.length - 1]?.date ?? '') : '';
  const plotWidth = mode === 'braille' ? Math.ceil(visible.length / 2) : visible.length * 2;
  const gap = Math.max(1, plotWidth - displayWidth(first) - displayWidth(last));
  rows.push(
    joinLine(
      span(' '.repeat(AXIS_WIDTH - 1)),
      span('└', 'border'),
      span(`${first}${' '.repeat(gap)}${last}`.trimEnd(), 'muted'),
    ),
  );
  return rows;
}
