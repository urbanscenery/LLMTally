import { describe, expect, test } from 'bun:test';

import type { CostResult } from '@llmtally/core/pricing/types.ts';
import type { ReportBucket, ReportSummary } from '@llmtally/core/report/types.ts';
import { renderBreakdownTable } from '@llmtally/tui/components/breakdown-table.ts';
import { createInitialState, withActiveTab, withTabResource } from '@llmtally/tui/state.ts';
import { toBreakdownViewModel } from '@llmtally/tui/view-model/breakdown.ts';
import { agentsTabView } from '@llmtally/tui/views/breakdown.ts';
import { frameText } from '@llmtally/tui/rich-text.ts';
import { viewText } from './helpers.ts';

const NOW = 1_800_000_000;

function cost(basis: 'spend' | 'quota', overrides: Partial<CostResult> = {}): CostResult {
  return {
    basis,
    usd: basis === 'spend' ? null : 42.5,
    pricedSubtotalUsd: basis === 'spend' ? 0 : 42.5,
    pricedRows: basis === 'spend' ? 0 : 9,
    unpricedRows: 0,
    warnings: [],
    ...overrides,
  };
}

function bucket(key: string, rowCount: number): ReportBucket {
  return {
    key,
    rowCount,
    promptCount: rowCount,
    tokens: {
      inputTokens: rowCount * 1000,
      outputTokens: rowCount * 10,
      cacheWrite: 0,
      cacheRead: rowCount * 500,
      reasoningTokens: rowCount,
    },
    spendCost: cost('spend'),
    quotaCost: cost('quota'),
    unpricedRows: 0,
    unknownRows: 0,
    unknownUsd: 0,
    unpricedModels: [],
  };
}

function summaryFixture(buckets: ReportBucket[]): ReportSummary {
  return {
    command: 'report',
    databasePath: '/tmp/test.db',
    groupBy: 'agent',
    agent: null,
    range: { fromDate: null, toDate: null },
    buckets,
    totals: bucket('all', buckets.reduce((acc, b) => acc + b.rowCount, 0)),
    pricing: { status: 'fresh', asOfUtc: NOW, sources: [], warnings: [] },
  };
}

describe('toBreakdownViewModel', () => {
  test('sorts by promptCount desc then key asc deterministically', () => {
    // Arrange
    const summary = summaryFixture([bucket('cline', 5), bucket('codex', 90), bucket('claude-code', 90)]);

    // Act
    const model = toBreakdownViewModel('agent', summary);

    // Assert
    expect(model.rows.map((row) => row.key)).toEqual(['claude-code', 'codex', 'cline']);
    expect(model.totals.key).toBe('total');
  });

  test('sanitizes keys carrying control bytes', () => {
    // Arrange
    const ESC = String.fromCharCode(27);
    const summary = summaryFixture([bucket(`bad${ESC}[9999Hagent`, 1)]);

    // Act
    const model = toBreakdownViewModel('agent', summary);

    // Assert
    expect(model.rows[0]?.key).toBe('bad[9999Hagent');
  });
});

describe('renderBreakdownTable', () => {
  test('a spend-free ledger hides the Spend column entirely', () => {
    // Arrange — fixture has zero spend rows everywhere
    const model = toBreakdownViewModel('agent', summaryFixture([bucket('claude-code', 10)]));

    // Act
    const lines = frameText(renderBreakdownTable(model, 120, 10));
    const header = lines[0] ?? '';

    // Assert — no all-“—” column resurrecting the two-cost confusion
    expect(header).toContain('Quota');
    expect(header).not.toContain('Spend');
    expect(lines.join('\n')).toContain('~$ 42.50');
    expect(lines[lines.length - 1]).toContain('total');
  });

  test('spend rows bring the Spend column back as a separate column', () => {
    // Arrange — one bucket carries billed money; the totals row is the
    // visibility authority, as it is in a real fold
    const spend = cost('spend', { usd: 1.25, pricedSubtotalUsd: 1.25, pricedRows: 4 });
    const spendBucket: ReportBucket = { ...bucket('opencode', 4), spendCost: spend };
    const summary = summaryFixture([spendBucket]);
    const model = toBreakdownViewModel('agent', {
      ...summary,
      totals: { ...summary.totals, spendCost: spend },
    });

    // Act
    const lines = frameText(renderBreakdownTable(model, 120, 10));
    const header = lines[0] ?? '';

    // Assert
    expect(header).toContain('Spend');
    expect(header).toContain('Quota');
    expect(lines.join('\n')).toContain('$ 1.25');
  });

  test('narrow width drops low-priority columns but keeps usage cost', () => {
    // Arrange
    const model = toBreakdownViewModel('agent', summaryFixture([bucket('claude-code', 10)]));

    // Act
    const lines = frameText(renderBreakdownTable(model, 60, 10));
    const header = lines[0] ?? '';

    // Assert
    expect(header).toContain('Name');
    expect(header).toContain('Quota');
    expect(header).not.toContain('CacheW');
  });

  test('long unicode keys truncate without breaking row width', () => {
    // Arrange
    const longKey = '아주긴한글모델이름'.repeat(4);
    const model = toBreakdownViewModel('model', summaryFixture([bucket(longKey, 3)]));

    // Act
    const lines = frameText(renderBreakdownTable(model, 100, 10));

    // Assert
    const dataRow = lines[2] ?? '';
    expect(dataRow).toContain('…');
    expect(Bun.stringWidth(dataRow)).toBeLessThanOrEqual(100);
  });

  test('row overflow is capped with a more marker', () => {
    // Arrange
    const many = Array.from({ length: 30 }, (_, i) => bucket(`agent-${String(i).padStart(2, '0')}`, 30 - i));
    const model = toBreakdownViewModel('agent', summaryFixture(many));

    // Act
    const lines = frameText(renderBreakdownTable(model, 120, 5));

    // Assert
    expect(lines.join('\n')).toContain('… 25 more');
  });
});

describe('agentsTabView', () => {
  test('renders inside state with ready data', () => {
    // Arrange
    const model = toBreakdownViewModel('agent', summaryFixture([bucket('codex', 7)]));
    const state = withTabResource(withActiveTab(createInitialState(), 'agents'), 'agents', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });

    // Act
    const text = viewText(agentsTabView(state, 100, 24, NOW)).join('\n');

    // Assert
    expect(text).toContain('codex');
    expect(text).toContain('total');
  });

  test('idle state prompts that agents are not loaded', () => {
    // Act
    const text = viewText(agentsTabView(createInitialState(), 80, 24, NOW)).join('');

    // Assert
    expect(text).toContain('agents not loaded yet');
  });
});

describe('sortable tables', () => {
  test('sortBreakdownRows orders by spend cost with key tiebreak', async () => {
    // Arrange
    const { sortBreakdownRows } = await import('@llmtally/tui/view-model/breakdown.ts');
    const model = toBreakdownViewModel(
      'agent',
      summaryFixture([bucket('opencode', 3), bucket('codex', 90), bucket('claude-code', 10)]),
    );

    // Act — usage-only rows have spend usd null → subtotal 0 → tie on spend
    const byInput = sortBreakdownRows(model.rows, { column: 'input', direction: 'asc' });
    const byActual = sortBreakdownRows(model.rows, { column: 'cost', direction: 'desc' });

    // Assert
    expect(byInput.map((row) => row.key)).toEqual(['opencode', 'claude-code', 'codex']);
    expect(byActual.map((row) => row.key)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  test('d/c/t keys toggle sort on breakdown tabs only', () => {
    // Arrange
    const { TuiController } = require('@llmtally/tui/controller.ts');
    const { FakeScreen } = require('./helpers.ts');
    const screen = new FakeScreen();
    const controller = new TuiController({ screen, nowUtc: () => NOW });
    controller.start();

    // Act & Assert — on overview, sort keys do nothing
    screen.pressKey('c');
    expect(controller.getState().agentsSort).toEqual({ column: 'rows', direction: 'desc' });

    // switch to agents, sort by cost, then toggle direction
    screen.pressKey('3');
    screen.pressKey('c');
    expect(controller.getState().agentsSort).toEqual({ column: 'cost', direction: 'desc' });
    screen.pressKey('c');
    expect(controller.getState().agentsSort).toEqual({ column: 'cost', direction: 'asc' });
    screen.pressKey('t');
    expect(controller.getState().agentsSort).toEqual({ column: 'input', direction: 'desc' });
    // models keeps its own independent spec
    expect(controller.getState().modelsSort).toEqual({ column: 'rows', direction: 'desc' });
  });

  test('header carries the sort arrow and summary reports the state', () => {
    // Arrange
    const model = toBreakdownViewModel('agent', summaryFixture([bucket('codex', 7)]));
    const state = withTabResource(withActiveTab(createInitialState(), 'agents'), 'agents', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });

    // Act
    const text = viewText(agentsTabView(state, 120, 24, NOW)).join('\n');

    // Assert
    expect(text).toContain('Rows↓');
    expect(text).toContain('Agents [1]');
    expect(text).toContain('sort Rows↓');
  });
});
