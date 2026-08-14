import { renderCostSummary, renderTokenSummary, unclassifiedNote, QUOTA_COST_DISCLAIMER } from '../components/cost-summary.ts';
import {
  blockChartIndexAtColumn,
  renderDailyBlockChart,
} from '../components/daily-block-chart.ts';
import {
  CONTRIBUTION_ROWS,
  contributionIndexAtCell,
  renderContributionGraph,
} from '../components/contribution-graph.ts';
import { renderDayDetail } from '../components/day-detail.ts';
import type { ChartStyle } from '../components/chart-style.ts';
import { densityFor } from '../layout.ts';
import { joinLine, span } from '../rich-text.ts';
import type { TuiState } from '../state.ts';
import { fitLine } from '../text.ts';
import type { OverviewViewModel } from '../view-model/overview.ts';
import type { TabView, TabViewLine } from './shell.ts';

const MIN_CHART_HEIGHT = 3;
const MAX_CHART_HEIGHT = 10;
const COST_STACK_BREAKPOINT = 82;

const CHART_TITLES: Record<ChartStyle, string> = {
  block: ' Daily input tokens',
  braille: ' Daily input tokens',
  heatmap: ' Daily input tokens (calendar)',
};

interface ChartGeometry {
  /** Style actually drawn; heatmap falls back to bars when too short. */
  readonly style: ChartStyle;
  /** 0-based body row of the first plot row; null when no chart fits. */
  readonly top: number | null;
  readonly height: number;
  readonly compact: boolean;
}

/**
 * One geometry for rendering and click mapping: the reserved-space
 * budget below the chart decides how tall it gets, and the click
 * handler must agree on where the plot rows sit or a click would
 * select a different day than the one under the pointer. While a day
 * is selected the bar chart drops to its minimum height — the detail
 * cards below are what the user is looking at.
 */
function chartGeometry(
  width: number,
  height: number,
  style: ChartStyle,
  daySelected: boolean,
): ChartGeometry {
  const compact = densityFor(width, height) === 'compact';
  const cardLines = width < COST_STACK_BREAKPOINT ? 8 : 4;
  const blanks = compact ? 1 : 3;
  const reserved = 1 /* title */ + 1 /* chart axis */ + cardLines + blanks + 2; /* summary+disclaimer */
  const chartBudget = height - reserved - 1;
  if (chartBudget < MIN_CHART_HEIGHT) {
    return { style, top: null, height: 0, compact };
  }
  const effective = style === 'heatmap' && chartBudget < CONTRIBUTION_ROWS ? 'block' : style;
  const chartHeight =
    effective === 'heatmap'
      ? CONTRIBUTION_ROWS
      : daySelected
        ? MIN_CHART_HEIGHT
        : Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, chartBudget));
  // leading blank (comfortable only) + title line sit above the plot
  return { style: effective, top: (compact ? 0 : 1) + 1, height: chartHeight, compact };
}

function renderChart(
  model: OverviewViewModel,
  geometry: ChartGeometry,
  width: number,
  selectedIndex: number | null,
): TabViewLine[] {
  const points = model.chart.points;
  if (geometry.style === 'heatmap') {
    return renderContributionGraph(points, width, selectedIndex);
  }
  return renderDailyBlockChart(points, width, geometry.height, geometry.style, selectedIndex);
}

/** True when the view will render the day-detail cards for this state. */
export function overviewHasDaySelection(model: OverviewViewModel, selectedDate: string | null): boolean {
  return selectedDate !== null && model.chart.points.some((point) => point.date === selectedDate);
}

/**
 * The chart day a body click lands on, or null outside the plot. Row
 * and column are 0-based within the tab body. `selectedDate` must be
 * the state's current selection — the chart shrinks while a day is
 * selected, which moves the plot rows.
 */
export function overviewDateAtClick(
  model: OverviewViewModel,
  style: ChartStyle,
  width: number,
  height: number,
  bodyRow: number,
  column: number,
  selectedDate: string | null = null,
): string | null {
  const geometry = chartGeometry(width, height, style, overviewHasDaySelection(model, selectedDate));
  if (geometry.top === null) {
    return null;
  }
  const plotRow = bodyRow - geometry.top;
  if (plotRow < 0 || plotRow >= geometry.height) {
    return null;
  }
  const points = model.chart.points;
  const chartWidth = width - 2;
  const index =
    geometry.style === 'heatmap'
      ? contributionIndexAtCell(points, chartWidth, plotRow, column)
      : blockChartIndexAtColumn(points.length, chartWidth, geometry.style, column);
  return index === null ? null : (points[index]?.date ?? null);
}

export function makeOverviewTabView(
  chartStyle: ChartStyle | (() => ChartStyle) = 'block',
): TabView {
  const styleNow = (): ChartStyle =>
    typeof chartStyle === 'function' ? chartStyle() : chartStyle;
  return (state: TuiState, width: number, height: number): readonly TabViewLine[] => {
    const resource = state.overview;
    const model = resource.data;
    if (model === null) {
      if (resource.phase === 'loading') {
        return [fitLine('  loading usage…', width)];
      }
      if (resource.phase === 'error') {
        return [fitLine(`  usage unavailable: ${resource.error ?? 'unknown error'}`, width)];
      }
      return [fitLine('  usage not loaded yet', width)];
    }
    if (model.totals.rowCount === 0) {
      return ['', fitLine('  ledger is empty — press r to collect your agent logs', width)];
    }

    // reserve everything below the chart FIRST so cost cards, token
    // summary, and the usage disclaimer are never clipped at 80x24
    const selectedIndex =
      state.overviewSelectedDate === null
        ? null
        : model.chart.points.findIndex((point) => point.date === state.overviewSelectedDate);
    const selectedPoint = selectedIndex === null ? undefined : model.chart.points[selectedIndex];
    const geometry = chartGeometry(width, height, styleNow(), selectedPoint !== undefined);
    const lines: TabViewLine[] = geometry.compact ? [] : [''];
    if (geometry.top !== null) {
      lines.push(joinLine(span(CHART_TITLES[geometry.style], 'tableHeader')));
      lines.push(
        ...renderChart(
          model,
          geometry,
          width - 2,
          selectedIndex !== null && selectedIndex >= 0 ? selectedIndex : null,
        ),
      );
      if (!geometry.compact) {
        lines.push('');
      }
    }
    if (selectedPoint !== undefined) {
      // a selected day replaces the all-time cards with that day's
      // totals and breakdowns; the disclaimer keeps its last line
      const detailBudget = height - lines.length - 1;
      lines.push(...renderDayDetail(selectedPoint, state.overviewDayDetail, width, detailBudget));
    } else {
      lines.push(...renderCostSummary(model, width));
      if (!geometry.compact) {
        lines.push('');
      }
      lines.push(joinLine(span(fitLine(renderTokenSummary(model), width), 'muted')));
    }
    const unclassified = unclassifiedNote(model);
    if (unclassified !== null) {
      lines.push(joinLine(span(fitLine(` ${unclassified}`, width), 'warning')));
    }
    lines.push(joinLine(span(fitLine(` ${QUOTA_COST_DISCLAIMER}`, width), 'dim')));
    if (resource.phase === 'error') {
      lines.push(
        joinLine(
          span(
            fitLine(`  ! refresh failed: ${resource.error ?? 'unknown'} (showing last data)`, width),
            'danger',
          ),
        ),
      );
    }
    return lines;
  };
}

export const overviewTabView: TabView = makeOverviewTabView();
