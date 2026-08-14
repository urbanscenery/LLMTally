import { describe, expect, test } from 'bun:test';

import { renderReportJson, renderReportText } from '@llmtally/core/report/render.ts';
import type { ReportBucket, ReportSummary } from '@llmtally/core/report/types.ts';

function bucket(key: string, overrides: Partial<ReportBucket> = {}): ReportBucket {
  return {
    key,
    rowCount: 1204,
    tokens: {
      inputTokens: 12_345_678,
      outputTokens: 423_100,
      cacheWrite: 24_000,
      cacheRead: 8_120_000,
      reasoningTokens: 88_200,
    },
    spendCost: {
      basis: 'spend',
      usd: 1.2841,
      pricedSubtotalUsd: 1.2841,
      pricedRows: 100,
      unpricedRows: 0,
      warnings: [],
    },
    quotaCost: {
      basis: 'quota',
      usd: null,
      pricedSubtotalUsd: 42.8173,
      pricedRows: 950,
      unpricedRows: 154,
      warnings: [{ code: 'unknown_model', model: 'unknown', rows: 154 }],
    },
    unknownRows: 0,
    unknownUsd: 0,
    unpricedRows: 154,
    unpricedModels: ['unknown'],
    ...overrides,
  };
}

const summary: ReportSummary = {
  command: 'report',
  databasePath: '/tmp/ledger.db',
  groupBy: 'day',
  agent: null,
  range: { fromDate: null, toDate: null },
  buckets: [bucket('2026-08-09')],
  totals: bucket('TOTAL'),
  pricing: { status: 'stale', asOfUtc: 1_786_291_200, sources: ['litellm'], warnings: [] },
};

describe('renderReportText', () => {
  test('renders a table with separated spend and quota cost columns and a legend', () => {
    // Act
    const text = renderReportText(summary);

    // Assert
    expect(text).toContain('Range: all-time');
    expect(text).toContain('Spend USD');
    expect(text).toContain('Quota USD');
    expect(text).toContain('$1.284100');
    expect(text).toContain('$42.817300*');
    expect(text).toContain('NOT billed money');
    expect(text).toContain('TOTAL');
    expect(text).toContain('12,345,678');
    // no unclassified rows → no unclassified legend line
    expect(text).not.toContain('Unclassified');
  });

  test('renders an em dash when nothing in a column could be priced', () => {
    // Arrange
    const empty = {
      ...summary,
      buckets: [
        bucket('2026-08-10', {
          spendCost: { basis: 'unpriced', usd: null, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 3, warnings: [] },
        }),
      ],
    };

    // Act & Assert
    expect(renderReportText(empty)).toContain('—');
  });

  test('surfaces unclassified rows with their stamped amount in the legend', () => {
    // Arrange
    const withUnknown = {
      ...summary,
      totals: bucket('TOTAL', { unknownRows: 5, unknownUsd: 0.5 }),
    };

    // Act
    const text = renderReportText(withUnknown);

    // Assert — amount visible, and the fix (billing.overrides) named
    expect(text).toContain('Unclassified: 5 rows');
    expect(text).toContain('$0.500000');
    expect(text).toContain('billing.overrides');
  });
});

describe('renderReportJson', () => {
  test('serializes raw numbers without any display formatting', () => {
    // Act
    const parsed = JSON.parse(renderReportJson(summary));

    // Assert
    expect(parsed.totals.spendCost.usd).toBe(1.2841);
    expect(parsed.totals.quotaCost.usd).toBeNull();
    expect(parsed.totals.quotaCost.pricedSubtotalUsd).toBe(42.8173);
    expect(parsed.pricing.status).toBe('stale');
  });
});
