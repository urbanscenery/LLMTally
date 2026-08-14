import { formatCompact } from '../format.ts';
import { rampIndex } from '../gradient.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine, StyledSpan } from '../rich-text.ts';
import { displayWidth, padStartWidth } from '../text.ts';
import type { DailyPointViewModel } from '../view-model/overview.ts';

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
export const AXIS_WIDTH = 7;

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

/** Cells available for plotting once the value axis is subtracted. */
export function chartPlotCells(width: number): number {
  return Math.max(1, width - AXIS_WIDTH - 1);
}

/**
 * The window of points the bar chart shows: always the most recent ones
 * that fit. Selection, rendering, and click mapping all share this so
 * they can never disagree about which day a column is.
 */
export function blockChartWindow(
  pointCount: number,
  width: number,
  mode: ChartGlyphMode,
): { readonly start: number; readonly count: number } {
  const plotCells = chartPlotCells(width);
  const fit = mode === 'braille' ? plotCells * 2 : Math.max(1, Math.floor(plotCells / 2));
  const count = Math.min(pointCount, fit);
  return { start: pointCount - count, count };
}

/**
 * The point index (into the full array) a click on plot column `column`
 * lands on, or null between/outside columns. `column` is 0-based from
 * the left edge of the chart line.
 */
export function blockChartIndexAtColumn(
  pointCount: number,
  width: number,
  mode: ChartGlyphMode,
  column: number,
): number | null {
  const cell = column - AXIS_WIDTH;
  if (cell < 0) {
    return null;
  }
  const { start, count } = blockChartWindow(pointCount, width, mode);
  // braille packs two samples per cell; an odd count is left-padded
  // with a blank sample so dates stay in order (matches the renderer).
  // A cell click cannot tell its two days apart — it takes the left
  // one, except the pad cell whose only real sample is on the right.
  const offset =
    mode === 'braille' ? Math.max(0, cell * 2 - (count % 2)) : Math.floor(cell / 2);
  const index = start + offset;
  if (offset >= count || index >= pointCount) {
    return null;
  }
  return index;
}

/** Spans for one plot row, splitting out the selected day's cell. */
function rowSpans(
  cells: readonly string[],
  role: StyledSpan['role'],
  selectedCell: number | null,
): StyledSpan[] {
  if (selectedCell === null || selectedCell < 0 || selectedCell >= cells.length) {
    return [span(cells.join('').trimEnd(), role)];
  }
  const before = cells.slice(0, selectedCell).join('');
  const after = cells.slice(selectedCell + 1).join('').trimEnd();
  const spans: StyledSpan[] = [];
  if (before.length > 0) {
    spans.push(span(before, role));
  }
  spans.push(span(cells[selectedCell] ?? '', 'selected'));
  if (after.length > 0) {
    spans.push(span(after, role));
  }
  return spans;
}

/**
 * Pure vertical chart. Shows the most recent points that fit the
 * width (block: 1 point per 2 cells; braille: 2 points per cell). A
 * flat zero series renders an empty plot without dividing by zero.
 * Output is exactly `height` rows plus one date-axis row.
 * `selectedIndex` (into the full points array) highlights that day's
 * column when it falls inside the visible window.
 */
export function renderDailyBlockChart(
  points: readonly DailyPointViewModel[],
  width: number,
  height: number,
  mode: ChartGlyphMode = 'block',
  selectedIndex: number | null = null,
): RichLine[] {
  const plotHeight = Math.max(1, height);
  const window = blockChartWindow(points.length, width, mode);
  const visible = points.slice(window.start, window.start + window.count);
  const max = visible.reduce((acc, point) => Math.max(acc, point.value), 0);
  const selectedOffset =
    selectedIndex !== null && selectedIndex >= window.start ? selectedIndex - window.start : null;
  const selectedCell =
    selectedOffset === null || selectedOffset >= visible.length
      ? null
      : mode === 'braille'
        ? Math.floor((selectedOffset + (visible.length % 2)) / 2)
        : selectedOffset;

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
        ...rowSpans(cells, chartRole(row, plotHeight), selectedCell),
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
