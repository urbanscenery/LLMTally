import { renderCostSummary, renderTokenSummary, NOMINAL_DISCLAIMER } from '../components/cost-summary.ts';
import { renderDailyBlockChart } from '../components/daily-block-chart.ts';
import type { ChartGlyphMode } from '../components/daily-block-chart.ts';
import { densityFor } from '../layout.ts';
import { joinLine, span } from '../rich-text.ts';
import type { TuiState } from '../state.ts';
import { fitLine } from '../text.ts';
import type { TabView, TabViewLine } from './shell.ts';

const MIN_CHART_HEIGHT = 3;
const MAX_CHART_HEIGHT = 10;
const COST_STACK_BREAKPOINT = 82;

export function makeOverviewTabView(chartMode: ChartGlyphMode = 'block'): TabView {
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
    // summary, and the nominal disclaimer are never clipped at 80x24
    const compact = densityFor(width, height) === 'compact';
    const cardLines = width < COST_STACK_BREAKPOINT ? 8 : 4;
    const blanks = compact ? 1 : 3;
    const reserved = 1 /* title */ + 1 /* chart axis */ + cardLines + blanks + 2; /* summary+disclaimer */
    const chartBudget = height - reserved - 1;
    const chartHeight = Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, chartBudget));
    const lines: TabViewLine[] = compact ? [] : [''];
    if (chartBudget >= MIN_CHART_HEIGHT) {
      lines.push(joinLine(span(' Daily input tokens', 'tableHeader')));
      lines.push(...renderDailyBlockChart(model.chart.points, width - 2, chartHeight, chartMode));
      if (!compact) {
        lines.push('');
      }
    }
    lines.push(...renderCostSummary(model, width));
    if (!compact) {
      lines.push('');
    }
    lines.push(joinLine(span(fitLine(renderTokenSummary(model), width), 'muted')));
    lines.push(joinLine(span(fitLine(` ${NOMINAL_DISCLAIMER}`, width), 'dim')));
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
