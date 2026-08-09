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
    actual: {
      basis: 'actual',
      usd: 1.2841,
      pricedSubtotalUsd: 1.2841,
      pricedRows: 100,
      unpricedRows: 0,
      warnings: [],
    },
    nominal: {
      basis: 'nominal',
      usd: null,
      pricedSubtotalUsd: 42.8173,
      pricedRows: 950,
      unpricedRows: 154,
      warnings: [{ code: 'unknown_model', model: 'unknown', rows: 154 }],
    },
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
  test('renders a table with separated actual and nominal columns and a legend', () => {
    // Act
    const text = renderReportText(summary);

    // Assert
    expect(text).toContain('Range: all-time');
    expect(text).toContain('Actual USD');
    expect(text).toContain('Nominal API-eq USD');
    expect(text).toContain('$1.284100');
    expect(text).toContain('$42.817300*');
    expect(text).toContain('NOT actual spend');
    expect(text).toContain('TOTAL');
    expect(text).toContain('12,345,678');
  });

  test('renders an em dash when nothing in a column could be priced', () => {
    // Arrange
    const empty = {
      ...summary,
      buckets: [
        bucket('2026-08-10', {
          actual: { basis: 'unpriced', usd: null, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 3, warnings: [] },
        }),
      ],
    };

    // Act & Assert
    expect(renderReportText(empty)).toContain('—');
  });
});

describe('renderReportJson', () => {
  test('serializes raw numbers without any display formatting', () => {
    // Act
    const parsed = JSON.parse(renderReportJson(summary));

    // Assert
    expect(parsed.totals.actual.usd).toBe(1.2841);
    expect(parsed.totals.nominal.usd).toBeNull();
    expect(parsed.totals.nominal.pricedSubtotalUsd).toBe(42.8173);
    expect(parsed.pricing.status).toBe('stale');
  });
});
