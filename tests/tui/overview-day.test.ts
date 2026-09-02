import { describe, expect, test } from 'bun:test';

import type { CostResult } from '@llmtally/core/pricing/types.ts';
import type { ReportBucket, ReportSummary } from '@llmtally/core/report/types.ts';
import {
  blockChartIndexAtColumn,
  renderDailyBlockChart,
} from '@llmtally/tui/components/daily-block-chart.ts';
import {
  contributionIndexAtCell,
  renderContributionGraph,
} from '@llmtally/tui/components/contribution-graph.ts';
import {
  createInitialState,
  withOverviewDetailScroll,
  withOverviewSelectedDate,
  withTabResource,
} from '@llmtally/tui/state.ts';
import { formatCostCell, primaryCostViewModel, toCostViewModel } from '@llmtally/tui/view-model/cost.ts';
import { toDayDetailViewModel } from '@llmtally/tui/view-model/day-detail.ts';
import { toOverviewViewModel } from '@llmtally/tui/view-model/overview.ts';
import type { DailyPointViewModel } from '@llmtally/tui/view-model/overview.ts';
import {
  makeOverviewTabView,
  overviewDateAtClick,
  overviewDetailScrollInfo,
} from '@llmtally/tui/views/overview.ts';
import type { TabViewLine } from '@llmtally/tui/views/shell.ts';
import { viewText } from './helpers.ts';

const NOW = 1_800_000_000;

function cost(overrides: Partial<CostResult> = {}): CostResult {
  return {
    basis: 'quota',
    usd: 12.5,
    pricedSubtotalUsd: 12.5,
    pricedRows: 10,
    unpricedRows: 0,
    warnings: [],
    ...overrides,
  };
}

function bucket(key: string, inputTokens: number, overrides: Partial<ReportBucket> = {}): ReportBucket {
  return {
    key,
    rowCount: 5,
    promptCount: 5,
    tokens: { inputTokens, outputTokens: 100, cacheWrite: 0, cacheRead: 50, reasoningTokens: 7 },
    spendCost: cost({ basis: 'spend', usd: 1.25 }),
    quotaCost: cost(),
    unpricedRows: 0,
    unknownRows: 0,
    unknownUsd: 0,
    unpricedModels: [],
    ...overrides,
  };
}

function summaryFixture(buckets: ReportBucket[], groupBy: 'day' | 'agent' | 'model' = 'day'): ReportSummary {
  return {
    command: 'report',
    databasePath: '/tmp/test.db',
    groupBy,
    agent: null,
    range: { fromDate: null, toDate: null },
    buckets,
    totals: bucket('total', buckets.reduce((acc, b) => acc + b.tokens.inputTokens, 0), {
      rowCount: buckets.length * 5,
      promptCount: buckets.length * 5,
    }),
    pricing: { status: 'fresh', asOfUtc: NOW, sources: [], warnings: [] },
  };
}

function point(date: string, value: number): DailyPointViewModel {
  return {
    date,
    value,
    rowCount: 5,
    promptCount: 5,
    tokens: { inputTokens: value, outputTokens: 100, cacheWrite: 0, cacheRead: 50, reasoningTokens: 7 },
    spendCost: toCostViewModel('spend', cost({ basis: 'spend', usd: 1.25 })),
    quotaCost: toCostViewModel('quota', cost()),
    unknownRows: 0,
    unknownUsd: 0,
  };
}

/** Every span role used in a rendered view, for highlight assertions. */
function rolesOf(lines: readonly TabViewLine[]): Set<string> {
  const roles = new Set<string>();
  for (const line of lines) {
    if (typeof line === 'string') {
      continue;
    }
    for (const item of line) {
      if (typeof item !== 'string' && item.role !== undefined) {
        roles.add(item.role);
      }
    }
  }
  return roles;
}

describe('renderContributionGraph', () => {
  test('renders 7 weekday rows plus the date axis', () => {
    // Arrange — 2026-08-03 is a Monday
    const points = [point('2026-08-03', 10), point('2026-08-04', 20), point('2026-08-06', 30)];

    // Act
    const lines = renderContributionGraph(points, 60);
    const text = viewText(lines);

    // Assert
    expect(lines).toHaveLength(8);
    expect(text.join('\n')).toContain('Mon');
    // the gap day (08-05) inside the range renders as a quiet dot
    expect(text.join('')).toContain('·');
  });

  test('selected day renders with the selection role', () => {
    // Arrange
    const points = [point('2026-08-03', 10), point('2026-08-04', 20)];

    // Act & Assert
    expect(rolesOf(renderContributionGraph(points, 60, 1)).has('selected')).toBe(true);
    expect(rolesOf(renderContributionGraph(points, 60, null)).has('selected')).toBe(false);
  });

  test('click mapping resolves weekday row and week column to a data day', () => {
    // Arrange — Monday and Tuesday of one week
    const points = [point('2026-08-03', 10), point('2026-08-04', 20)];
    const mondayRow = new Date(Date.UTC(2026, 7, 3)).getUTCDay();
    const tuesdayRow = new Date(Date.UTC(2026, 7, 4)).getUTCDay();

    // Act & Assert — one visible week means column 7/8 is that week
    expect(contributionIndexAtCell(points, 60, mondayRow, 7)).toBe(0);
    expect(contributionIndexAtCell(points, 60, tuesdayRow, 7)).toBe(1);
    // an empty calendar cell (Sunday) selects nothing
    expect(contributionIndexAtCell(points, 60, 0, 7)).toBeNull();
    expect(contributionIndexAtCell(points, 60, mondayRow, 3)).toBeNull();
  });
});

describe('block chart selection', () => {
  test('the selected column renders with the selection role', () => {
    // Arrange
    const points = [point('2026-08-01', 10), point('2026-08-02', 1000)];

    // Act & Assert
    expect(rolesOf(renderDailyBlockChart(points, 60, 4, 'block', 1)).has('selected')).toBe(true);
    expect(rolesOf(renderDailyBlockChart(points, 60, 4, 'block', null)).has('selected')).toBe(false);
  });

  test('click mapping: two columns per day after the axis', () => {
    // Act & Assert
    expect(blockChartIndexAtColumn(3, 60, 'block', 7)).toBe(0);
    expect(blockChartIndexAtColumn(3, 60, 'block', 8)).toBe(0);
    expect(blockChartIndexAtColumn(3, 60, 'block', 9)).toBe(1);
    expect(blockChartIndexAtColumn(3, 60, 'block', 6)).toBeNull();
    expect(blockChartIndexAtColumn(3, 60, 'block', 13)).toBeNull();
  });
});

describe('primary cost basis', () => {
  test('actual wins when the source billed anything, else nominal', () => {
    // Arrange
    const billed = toCostViewModel('spend', cost({ basis: 'spend', usd: 1.25 }));
    const unbilled = toCostViewModel('spend', cost({ basis: 'spend', usd: null, pricedSubtotalUsd: 0, pricedRows: 0 }));
    const usage = toCostViewModel('quota', cost());

    // Act & Assert — data decides the basis, marked by its prefix
    expect(formatCostCell(primaryCostViewModel(billed, usage))).toBe('$ 1.25');
    expect(formatCostCell(primaryCostViewModel(unbilled, usage))).toBe('~$ 12.50');
  });

  test('a subscription agent card shows its usage as the one cost', () => {
    // Arrange — claude-code style: no source-billed rows at all
    const subscription = bucket('claude-code', 900, {
      spendCost: cost({ basis: 'spend', usd: null, pricedSubtotalUsd: 0, pricedRows: 0 }),
    });
    const model = toOverviewViewModel(summaryFixture([bucket('2026-08-02', 5000)]));
    let state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });
    state = withOverviewSelectedDate(state, '2026-08-02');
    const withDetail = {
      ...state,
      overviewDayDetail: {
        phase: 'ready' as const,
        data: toDayDetailViewModel('2026-08-02', summaryFixture([subscription], 'agent'), {
          'claude-code': summaryFixture([bucket('claude-fable-5', 900, {
            spendCost: cost({ basis: 'spend', usd: null, pricedSubtotalUsd: 0, pricedRows: 0 }),
          })], 'model'),
        }),
        error: null,
        updatedAtUtc: NOW,
        invalidated: false,
      },
    };

    // Act
    const text = viewText(makeOverviewTabView('block')(withDetail, 100, 30, NOW)).join('\n');

    // Assert — the card carries one meaningful figure, tilde-marked
    expect(text).toContain('claude-code · 5 prompts · ~$ 12.50');
    expect(text).not.toContain('claude-code · 5 prompts · —');
  });
});

describe('overview day selection state', () => {
  test('selecting a date resets the detail; clearing does too', () => {
    // Arrange
    let state = createInitialState();
    state = {
      ...state,
      overviewDayDetail: {
        phase: 'ready',
        data: { date: '2026-08-01', agents: [] },
        error: null,
        updatedAtUtc: NOW,
        invalidated: false,
      },
    };

    // Act
    const selected = withOverviewSelectedDate(state, '2026-08-02');

    // Assert — the old day's rows never render under the new header
    expect(selected.overviewSelectedDate).toBe('2026-08-02');
    expect(selected.overviewDayDetail.phase).toBe('idle');
    expect(withOverviewSelectedDate(selected, null).overviewSelectedDate).toBeNull();
  });
});

describe('overview view with a selected day', () => {
  function stateWithSelection() {
    const model = toOverviewViewModel(
      summaryFixture([bucket('2026-08-01', 1000), bucket('2026-08-02', 5000)]),
    );
    let state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });
    state = withOverviewSelectedDate(state, '2026-08-02');
    return {
      model,
      state: {
        ...state,
        overviewDayDetail: {
          phase: 'ready' as const,
          data: toDayDetailViewModel(
            '2026-08-02',
            summaryFixture([bucket('claude-code', 900), bucket('codex', 100)], 'agent'),
            {
              'claude-code': summaryFixture([bucket('claude-fable-5', 900)], 'model'),
              codex: summaryFixture([bucket('gpt-5.5', 100)], 'model'),
            },
          ),
          error: null,
          updatedAtUtc: NOW,
          invalidated: false,
        },
      },
    };
  }

  test('shows the day totals and breakdowns instead of the cost cards', () => {
    // Arrange
    const { state } = stateWithSelection();

    // Act
    const text = viewText(makeOverviewTabView('block')(state, 100, 30, NOW)).join('\n');

    // Assert — one card per agent, its models nested inside
    expect(text).toContain('▾ 2026-08-02');
    expect(text).toContain('5 prompts');
    expect(text).toContain('claude-code · 5 prompts');
    expect(text).toContain('codex · 5 prompts');
    expect(text).toContain('claude-fable-5');
    expect(text).toContain('gpt-5.5');
    expect(text).not.toContain('ACTUAL (out-of-pocket)');
    // the model row sits inside its agent's card frame
    const lines = text.split('\n');
    const cardTop = lines.findIndex((line) => line.includes('claude-code · 5 prompts'));
    const modelRow = lines.findIndex((line) => line.includes('claude-fable-5'));
    expect(cardTop).toBeGreaterThanOrEqual(0);
    expect(modelRow).toBeGreaterThan(cardTop);
    expect(lines[modelRow]).toContain('│');
  });

  test('a loading detail says so under the day header', () => {
    // Arrange
    const { state } = stateWithSelection();
    const loading = {
      ...state,
      overviewDayDetail: {
        phase: 'loading' as const,
        data: null,
        error: null,
        updatedAtUtc: null,
        invalidated: false,
      },
    };

    // Act & Assert
    const text = viewText(makeOverviewTabView('block')(loading, 100, 30, NOW)).join('\n');
    expect(text).toContain('loading day breakdown');
  });

  test('clicks on the plot map to dates; clicks outside do not', () => {
    // Arrange
    const { model } = stateWithSelection();

    // Act & Assert — comfortable layout: blank + title above the plot
    expect(overviewDateAtClick(model, 'block', 100, 30, 2, 7)).toBe('2026-08-01');
    expect(overviewDateAtClick(model, 'block', 100, 30, 2, 9)).toBe('2026-08-02');
    expect(overviewDateAtClick(model, 'block', 100, 30, 0, 9)).toBeNull();
    expect(overviewDateAtClick(model, 'block', 100, 30, 2, 0)).toBeNull();
  });

  test('the plot rows never move with the day selection', () => {
    // Arrange — 100x30 comfortable: 10 plot rows on body rows 2..11
    const { model } = stateWithSelection();

    // Act & Assert — the chart keeps its height while a day is
    // selected, so the same click always lands on the same day
    expect(overviewDateAtClick(model, 'block', 100, 30, 6, 7)).toBe('2026-08-01');
    expect(overviewDateAtClick(model, 'block', 100, 30, 11, 7)).toBe('2026-08-01');
    // the axis row below the plot selects nothing
    expect(overviewDateAtClick(model, 'block', 100, 30, 12, 7)).toBeNull();
  });
});

describe('overview day detail scrolling', () => {
  function stateWithManyModels() {
    const model = toOverviewViewModel(
      summaryFixture([bucket('2026-08-01', 1000), bucket('2026-08-02', 5000)]),
    );
    let state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready' as const,
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });
    state = withOverviewSelectedDate(state, '2026-08-02');
    const models = Array.from({ length: 30 }, (_, index) =>
      bucket(`model-${String(index).padStart(2, '0')}`, 900 - index),
    );
    return {
      model,
      state: {
        ...state,
        overviewDayDetail: {
          phase: 'ready' as const,
          data: toDayDetailViewModel(
            '2026-08-02',
            summaryFixture([bucket('claude-code', 900)], 'agent'),
            { 'claude-code': summaryFixture(models, 'model') },
          ),
          error: null,
          updatedAtUtc: NOW,
          invalidated: false,
        },
      },
    };
  }

  test('the chart keeps its height and the cards scroll below it', () => {
    // Arrange
    const { state } = stateWithManyModels();
    const view = makeOverviewTabView('block');

    // Act
    const top = viewText(view(state, 100, 30, NOW)).join('\n');
    const scrolled = viewText(
      view({ ...state, overviewDetailScroll: 999 }, 100, 30, NOW),
    ).join('\n');

    // Assert — full-height chart with a scroll window, not a squeeze
    expect(top).toContain('Daily input tokens');
    expect(top).toContain('↑↓ scroll');
    expect(top).toContain('model-00');
    expect(top).not.toContain('model-29');
    // an over-shoot clamps to the last page
    expect(scrolled).toContain('model-29');
    expect(scrolled).not.toContain('model-00');
  });

  test('scroll info agrees with the rendered card count', () => {
    // Arrange — one agent card: 3 chrome lines + 30 model rows
    const { model, state } = stateWithManyModels();

    // Act
    const info = overviewDetailScrollInfo(model, state.overviewDayDetail, 'block', 100, 30);

    // Assert
    expect(info.maxScroll).toBe(33 - info.cardRows);
    expect(info.maxScroll).toBeGreaterThan(0);
  });

  test('scroll resets when the selected day changes', () => {
    // Arrange
    let state = withOverviewSelectedDate(createInitialState(), '2026-08-01');
    state = withOverviewDetailScroll(state, 5);

    // Act & Assert
    expect(state.overviewDetailScroll).toBe(5);
    expect(withOverviewDetailScroll(state, -3).overviewDetailScroll).toBe(0);
    expect(withOverviewSelectedDate(state, '2026-08-02').overviewDetailScroll).toBe(0);
    expect(withOverviewSelectedDate(state, null).overviewDetailScroll).toBe(0);
  });
});
