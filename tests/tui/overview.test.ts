import { describe, expect, test } from 'bun:test';

import type { CostResult } from '@llmtally/core/pricing/types.ts';
import type { ReportBucket, ReportSummary } from '@llmtally/core/report/types.ts';
import { renderDailyBlockChart } from '@llmtally/tui/components/daily-block-chart.ts';
import { QUOTA_COST_DISCLAIMER, renderCostSummary } from '@llmtally/tui/components/cost-summary.ts';
import { createInitialState, withTabResource } from '@llmtally/tui/state.ts';
import { formatCostCell, toCostViewModel } from '@llmtally/tui/view-model/cost.ts';
import { toOverviewViewModel } from '@llmtally/tui/view-model/overview.ts';
import { overviewTabView } from '@llmtally/tui/views/overview.ts';
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
    spendCost: cost({ basis: 'spend', usd: null, pricedSubtotalUsd: 0, pricedRows: 0 }),
    quotaCost: cost(),
    unpricedRows: 0,
    unknownRows: 0,
    unknownUsd: 0,
    unpricedModels: [],
    ...overrides,
  };
}

function point(date: string, value: number) {
  return {
    date,
    value,
    rowCount: 5,
    promptCount: 5,
    tokens: { inputTokens: value, outputTokens: 100, cacheWrite: 0, cacheRead: 50, reasoningTokens: 7 },
    spendCost: toCostViewModel('spend', cost({ basis: 'spend' })),
    quotaCost: toCostViewModel('quota', cost()),
    unknownRows: 0,
    unknownUsd: 0,
  };
}

function summaryFixture(buckets: ReportBucket[]): ReportSummary {
  return {
    command: 'report',
    databasePath: '/tmp/test.db',
    groupBy: 'day',
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

describe('renderDailyBlockChart', () => {
  test('a zero series renders without dividing by zero', () => {
    // Act
    const lines = viewText(renderDailyBlockChart(
      [point('2026-08-01', 0), point('2026-08-02', 0)],
      60,
      4,
    ));

    // Assert
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('0│');
    expect(lines.join('')).not.toContain('█');
  });

  test('the max value fills the full column height', () => {
    // Act
    const lines = viewText(renderDailyBlockChart(
      [point('2026-08-01', 10), point('2026-08-02', 1000)],
      60,
      4,
    ));

    // Assert — top row shows the max bar full-block
    expect(lines[0]).toContain('█');
    expect(lines[0]).toContain('1.0K│');
  });

  test('only the most recent points that fit the width are drawn', () => {
    // Arrange
    const points = Array.from({ length: 100 }, (_, index) =>
      point(`2026-05-${String((index % 28) + 1).padStart(2, '0')}`, index),
    );

    // Act
    const lines = viewText(renderDailyBlockChart(points, 30, 3));

    // Assert — width 30 fits (30-8)/2=11 columns
    const plotCells = (lines[0] ?? '').split('│')[1] ?? '';
    expect(plotCells.replaceAll(' ', '').length).toBeLessThanOrEqual(11);
  });
});

describe('cost view model', () => {
  test('actual and usage render with distinct structural prefixes', () => {
    // Act & Assert
    expect(formatCostCell(toCostViewModel('spend', cost({ basis: 'spend' })))).toBe('$ 12.50');
    expect(formatCostCell(toCostViewModel('quota', cost()))).toBe('~$ 12.50');
  });

  test('partial pricing shows the subtotal with a plus marker', () => {
    // Act
    const partial = toCostViewModel('quota', cost({ usd: null, pricedSubtotalUsd: 3.25, pricedRows: 4, unpricedRows: 2 }));

    // Assert
    expect(partial.partial).toBe(true);
    expect(formatCostCell(partial)).toBe('~$ 3.25+');
  });

  test('zero priced rows renders an em dash', () => {
    // Act & Assert
    expect(
      formatCostCell(toCostViewModel('spend', cost({ usd: null, pricedSubtotalUsd: 0, pricedRows: 0 }))),
    ).toBe('—');
  });
});

describe('overviewTabView', () => {
  test('renders chart, separated cost cards, and the usage disclaimer', () => {
    // Arrange
    const model = toOverviewViewModel(
      summaryFixture([bucket('2026-08-01', 1000), bucket('2026-08-02', 5000)]),
    );
    const state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });

    // Act
    const text = viewText(overviewTabView(state, 100, 30, NOW)).join('\n');

    // Assert — a spend-free ledger shows the usage card alone
    expect(text).toContain('Daily input tokens');
    expect(text).toContain('QUOTA COST (list-price)');
    expect(text).not.toContain('SPEND');
    expect(text).toContain(QUOTA_COST_DISCLAIMER.slice(0, 40));
    expect(text).not.toContain('NaN');
  });

  test('empty ledger tells the user how to collect', () => {
    // Arrange
    const model = toOverviewViewModel(summaryFixture([]));
    const state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready',
      data: { ...model, totals: { ...model.totals, rowCount: 0 } },
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });

    // Act & Assert
    expect(viewText(overviewTabView(state, 80, 24, NOW)).join('')).toContain('press r to collect');
  });

  test('spend rows bring the SPEND card back; narrow terminals stack it above usage', () => {
    // Arrange — totals carry billed money
    const base = toOverviewViewModel(summaryFixture([bucket('2026-08-01', 10)]));
    const model = {
      ...base,
      totals: {
        ...base.totals,
        spendCost: { ...base.totals.spendCost, usd: 1.25, pricedSubtotalUsd: 1.25, pricedRows: 5, partial: false },
      },
    };

    // Act
    const lines = viewText(renderCostSummary(model, 60));
    const text = lines.join('\n');

    // Assert — both cards present, spend first, on separate lines
    const spendLine = lines.findIndex((line) => line.includes('SPEND'));
    const usageLine = lines.findIndex((line) => line.includes('QUOTA'));
    expect(spendLine).toBeGreaterThanOrEqual(0);
    expect(usageLine).toBeGreaterThan(spendLine);
    expect(text).toContain('SPEND COST (billed money)');
  });

  test('unclassified rows surface as a loud footnote with their amount', () => {
    // Arrange
    const base = toOverviewViewModel(summaryFixture([bucket('2026-08-01', 10)]));
    const model = {
      ...base,
      totals: { ...base.totals, unknownRows: 3, unknownUsd: 0.5 },
    };
    const state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });

    // Act
    const text = viewText(overviewTabView(state, 100, 30, NOW)).join('\n');

    // Assert — row count AND stamped amount, plus the fix location
    expect(text).toContain('3 rows unclassified');
    expect(text).toContain('$ 0.50');
    expect(text).toContain('billing.overrides');
  });
});

describe('overview height budget (review regression)', () => {
  test('80x24 keeps usage card, summary, and disclaimer visible', () => {
    // Arrange — realistic 90-day series
    const buckets = Array.from({ length: 90 }, (_, index) =>
      bucket(`2026-05-${String((index % 28) + 1).padStart(2, '0')}`, 1000 + index),
    );
    const model = toOverviewViewModel(summaryFixture(buckets));
    const state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });

    // Act — body height at 80x24 shell is 20
    const lines = viewText(overviewTabView(state, 80, 20, NOW));

    // Assert — everything fits inside the body budget
    expect(lines.length).toBeLessThanOrEqual(20);
    const text = lines.join('\n');
    expect(text).toContain('QUOTA COST (list-price)');
    expect(text).toContain('rows ');
    expect(text).toContain(QUOTA_COST_DISCLAIMER.slice(0, 30));
  });

  test('very short terminals drop the chart before dropping cost facts', () => {
    // Arrange
    const model = toOverviewViewModel(summaryFixture([bucket('2026-08-01', 10)]));
    const state = withTabResource(createInitialState(), 'overview', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });

    // Act — 60x14 body
    const lines = viewText(overviewTabView(state, 60, 14, NOW));

    // Assert
    expect(lines.length).toBeLessThanOrEqual(14);
    const text = lines.join('\n');
    expect(text).toContain('QUOTA COST');
    expect(text).toContain(QUOTA_COST_DISCLAIMER.slice(0, 30));
  });
});
