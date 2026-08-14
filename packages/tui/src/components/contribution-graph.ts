/**
 * GitHub-contributions calendar of the daily series: 7 weekday rows
 * (Sunday on top), one two-cell column per week, newest week rightmost.
 * Cell intensity is the day's share of the visible maximum on the
 * chart ramp; days without ledger rows render as dim dots. Exactly
 * CONTRIBUTION_ROWS plot rows plus one date-axis row.
 */
import { rampIndex } from '../gradient.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine, StyledSpan } from '../rich-text.ts';
import { displayWidth, padStartWidth } from '../text.ts';
import type { DailyPointViewModel } from '../view-model/overview.ts';

import { AXIS_WIDTH, chartPlotCells } from './daily-block-chart.ts';

export const CONTRIBUTION_ROWS = 7;
const DAY_MS = 86_400_000;
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''] as const;

/** Date-only epoch (UTC ms) — calendar math without timezone drift. */
function dateEpoch(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return null;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function epochToDate(epoch: number): string {
  const value = new Date(epoch);
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${value.getUTCFullYear()}-${month}-${day}`;
}

interface ContributionGrid {
  /** Epoch of the Sunday starting the leftmost visible week. */
  readonly firstSunday: number;
  readonly weekCount: number;
}

/**
 * Grid geometry shared by the renderer and the click mapping: the last
 * data day anchors the rightmost week, and as many whole weeks as fit
 * the width extend to the left.
 */
export function contributionGrid(
  points: readonly DailyPointViewModel[],
  width: number,
): ContributionGrid | null {
  const lastEpoch = dateEpoch(points[points.length - 1]?.date ?? '');
  const firstEpoch = dateEpoch(points[0]?.date ?? '');
  if (lastEpoch === null || firstEpoch === null) {
    return null;
  }
  const lastSunday = lastEpoch - new Date(lastEpoch).getUTCDay() * DAY_MS;
  const firstSunday = firstEpoch - new Date(firstEpoch).getUTCDay() * DAY_MS;
  const totalWeeks = Math.floor((lastSunday - firstSunday) / (7 * DAY_MS)) + 1;
  const weekCount = Math.min(totalWeeks, Math.max(1, Math.floor(chartPlotCells(width) / 2)));
  return {
    firstSunday: lastSunday - (weekCount - 1) * 7 * DAY_MS,
    weekCount,
  };
}

/**
 * The data-day index a click on (plot row, chart column) lands on, or
 * null on empty calendar cells and days without ledger rows.
 */
export function contributionIndexAtCell(
  points: readonly DailyPointViewModel[],
  width: number,
  row: number,
  column: number,
): number | null {
  const grid = contributionGrid(points, width);
  const cell = column - AXIS_WIDTH;
  if (grid === null || cell < 0 || row < 0 || row >= CONTRIBUTION_ROWS) {
    return null;
  }
  const week = Math.floor(cell / 2);
  if (week >= grid.weekCount) {
    return null;
  }
  const date = epochToDate(grid.firstSunday + (week * 7 + row) * DAY_MS);
  const index = points.findIndex((point) => point.date === date);
  return index < 0 ? null : index;
}

export function renderContributionGraph(
  points: readonly DailyPointViewModel[],
  width: number,
  selectedIndex: number | null = null,
): RichLine[] {
  const grid = contributionGrid(points, width);
  const byDate = new Map(points.map((point, index) => [point.date, { point, index }]));
  const max = points.reduce((acc, point) => Math.max(acc, point.value), 0);
  const firstDataEpoch = dateEpoch(points[0]?.date ?? '') ?? 0;
  const lastDataEpoch = dateEpoch(points[points.length - 1]?.date ?? '') ?? 0;
  const selectedDate = selectedIndex === null ? null : (points[selectedIndex]?.date ?? null);

  const rows: RichLine[] = [];
  for (let row = 0; row < CONTRIBUTION_ROWS; row += 1) {
    const spans: StyledSpan[] = [
      span(padStartWidth(WEEKDAY_LABELS[row] ?? '', AXIS_WIDTH - 1), 'muted'),
      span('│', 'border'),
    ];
    for (let week = 0; week < (grid?.weekCount ?? 0); week += 1) {
      const epoch = (grid?.firstSunday ?? 0) + (week * 7 + row) * DAY_MS;
      const date = epochToDate(epoch);
      const entry = byDate.get(date);
      if (entry !== undefined) {
        const percent = rampIndex(max === 0 ? 0 : (entry.point.value / max) * 100);
        spans.push(
          date === selectedDate
            ? span('■ ', 'selected')
            : span('■ ', `ramp:chart:${percent}`),
        );
      } else if (epoch >= firstDataEpoch && epoch <= lastDataEpoch) {
        // a calendar day inside the data range with no rows: quiet day
        spans.push(span('· ', 'dim'));
      } else {
        spans.push(span('  '));
      }
    }
    // drop trailing blanks so short rows do not paint the full width
    const lastSpan = spans[spans.length - 1];
    if (lastSpan !== undefined) {
      spans[spans.length - 1] = { ...lastSpan, text: lastSpan.text.trimEnd() };
    }
    rows.push(joinLine(...spans));
  }

  const first = grid === null ? '' : epochToDate(Math.max(grid.firstSunday, firstDataEpoch));
  const last = points.length > 1 ? (points[points.length - 1]?.date ?? '') : '';
  const plotWidth = (grid?.weekCount ?? 0) * 2;
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
