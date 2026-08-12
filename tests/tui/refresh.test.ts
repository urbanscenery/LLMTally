import { describe, expect, test } from 'bun:test';

import type { PromptListResult } from '@llmtally/core/report/prompts.ts';

import type { AccountsInput } from '@llmtally/tui/view-model/accounts.ts';
import type { ReportGroupBy, ReportSummary } from '@llmtally/core/report/types.ts';
import { ScanLockError } from '@llmtally/core/scan/lock.ts';
import type { ScanSummary } from '@llmtally/core/scan/types.ts';
import { TuiController } from '@llmtally/tui/controller.ts';
import type { TuiDataSource } from '@llmtally/tui/data-source.ts';
import { TabLoader } from '@llmtally/tui/loader.ts';
import { RefreshScheduler } from '@llmtally/tui/refresh.ts';
import { FakeScreen } from './helpers.ts';

const NOW = 1_800_000_000;

function scanSummary(): ScanSummary {
  return {
    agent: null,
    databasePath: '/tmp/x.db',
    discoveredFiles: 0,
    scannedFiles: 0,
    missingFiles: 0,
    insertedRows: 0,
    ignoredRows: 0,
    malformedLines: 0,
    pendingTails: 0,
    warnings: [],
    warningCounts: {},
    warningTotal: 0,
    startedAtUtc: NOW,
    finishedAtUtc: NOW,
  };
}

function reportSummary(groupBy: ReportGroupBy): ReportSummary {
  return {
    command: 'report',
    databasePath: '/tmp/x.db',
    groupBy,
    agent: null,
    range: { fromDate: null, toDate: null },
    buckets: [],
    totals: {
      key: 'total',
      rowCount: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, reasoningTokens: 0 },
      actual: { basis: 'actual', usd: null, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 0, warnings: [] },
      nominal: { basis: 'nominal', usd: null, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 0, warnings: [] },
      unpricedRows: 0,
      unpricedModels: [],
    },
    pricing: { status: 'fresh', asOfUtc: NOW, sources: [], warnings: [] },
  };
}

interface FakeDataSourceOptions {
  scanError?: () => Error | null;
  scanDelayMs?: number;
  scanWarningTotal?: number;
}

function makeFakes(options: FakeDataSourceOptions = {}) {
  const calls = { scan: 0, accounts: 0, report: [] as ReportGroupBy[] };
  const dataSource: TuiDataSource = {
    async scan(): Promise<ScanSummary> {
      calls.scan += 1;
      if (options.scanDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.scanDelayMs));
      }
      const error = options.scanError?.();
      if (error) {
        throw error;
      }
      return { ...scanSummary(), warningTotal: options.scanWarningTotal ?? 0 };
    },
    async loadAccounts(): Promise<AccountsInput> {
      calls.accounts += 1;
      return { snapshots: [], vault: [], discovered: [], activeAccountId: null };
    },
    async addCurrentAccount(): Promise<string> {
      return 'added';
    },
    async removeAccount(): Promise<string> {
      return 'removed';
    },
    async switchToAccount(): Promise<string> {
      return 'switched';
    },
    async detachCodexAccount(): Promise<string> {
      return 'detached';
    },
    async loadDoctorChecks(): Promise<readonly []> {
      return [];
    },
    invalidateQuotaCache(): void {
      // nothing cached in tests
    },
    async loadPrompts(): Promise<PromptListResult> {
      return { rows: [], truncated: false, warnings: [] };
    },
    async installDaemon(): Promise<string> {
      return 'installed';
    },
    async uninstallDaemon(): Promise<string> {
      return 'uninstalled';
    },
    async compactLedger(): Promise<string> {
      return 'compacted';
    },
    async loadReport(groupBy: ReportGroupBy): Promise<ReportSummary> {
      calls.report.push(groupBy);
      return reportSummary(groupBy);
    },
  };
  const screen = new FakeScreen();
  const controller = new TuiController({ screen, nowUtc: () => NOW });
  const loader = new TabLoader(controller, dataSource, () => NOW);
  return { calls, dataSource, screen, controller, loader };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('RefreshScheduler', () => {
  test('startup cycle scans and loads only the active tab', async () => {
    // Arrange
    const { calls, dataSource, controller, loader } = makeFakes();
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });

    // Act
    scheduler.start();
    await settle();
    scheduler.stop();

    // Assert
    expect(calls.scan).toBe(1);
    expect(calls.report).toEqual(['day']);
    expect(calls.accounts).toBe(0);
    expect(controller.getState().refresh.scanStatus).toBe('ok');
    expect(controller.getState().refresh.lastCompletedAtUtc).toBe(NOW);
    expect(controller.getState().overview.phase).toBe('ready');
  });

  test('concurrent manual requests coalesce into one pending run', async () => {
    // Arrange
    const { calls, dataSource, controller, loader } = makeFakes({ scanDelayMs: 30 });
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });

    // Act — one running cycle plus a burst of manual requests
    scheduler.start();
    scheduler.requestManual();
    scheduler.requestManual();
    scheduler.requestManual();
    await new Promise((resolve) => setTimeout(resolve, 120));
    scheduler.stop();

    // Assert — startup + exactly one coalesced manual
    expect(calls.scan).toBe(2);
  });

  test('a scan lock held by the daemon is busy, not fatal', async () => {
    // Arrange
    const { dataSource, controller, loader, calls } = makeFakes({
      scanError: () => new ScanLockError('/tmp/x.db.lock', 1234),
    });
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });

    // Act
    scheduler.start();
    await settle();
    scheduler.stop();

    // Assert — busy shown, but the report query still ran
    expect(controller.getState().refresh.scanStatus).toBe('busy');
    expect(calls.report).toEqual(['day']);
    expect(controller.getState().overview.phase).toBe('ready');
  });

  test('scan failure keeps the last good data on screen', async () => {
    // Arrange
    let failNext = false;
    const { dataSource, controller, loader } = makeFakes({
      scanError: () => (failNext ? new Error('disk exploded') : null),
    });
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });
    scheduler.start();
    await settle();
    const dataBefore = controller.getState().overview.data;

    // Act
    failNext = true;
    scheduler.requestManual();
    await settle();
    scheduler.stop();

    // Assert — error surfaced, but data stayed on screen (the active tab
    // re-queries the unchanged ledger, so contents are equal)
    expect(controller.getState().refresh.scanStatus).toBe('error');
    expect(dataBefore).not.toBeNull();
    expect(controller.getState().overview.data).toEqual(dataBefore);
    expect(controller.getState().overview.phase).toBe('ready');
  });

  test('successful scan invalidates inactive tabs for lazy reload', async () => {
    // Arrange
    const { calls, dataSource, controller, loader } = makeFakes();
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });
    scheduler.start();
    await settle();

    // Act — agents was invalidated by the cycle; switching loads it
    controller.handleKey({ name: '3', ctrl: false, shift: false });
    loader.loadIfNeeded('agents');
    await settle();
    scheduler.stop();

    // Assert
    expect(calls.report).toEqual(['day', 'agent']);
  });

  test('stop cancels the interval timer without further scans', async () => {
    // Arrange
    const { calls, dataSource, controller, loader } = makeFakes();
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 0.03,
      nowUtc: () => NOW,
    });

    // Act
    scheduler.start();
    await settle();
    scheduler.stop();
    const scansAtStop = calls.scan;
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert
    expect(calls.scan).toBe(scansAtStop);
  });

  test('interval reschedules only after the previous cycle completes', async () => {
    // Arrange
    const { calls, dataSource, controller, loader } = makeFakes();
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 0.03,
      nowUtc: () => NOW,
    });

    // Act
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 110));
    scheduler.stop();

    // Assert — startup + a few interval runs, never overlapping
    expect(calls.scan).toBeGreaterThanOrEqual(2);
    expect(calls.scan).toBeLessThanOrEqual(5);
  });

  test('auto-refresh starts OFF: only the startup scan runs', async () => {
    // Arrange — no intervalSeconds given
    const { calls, dataSource, controller, loader } = makeFakes();
    controller.start();
    const scheduler = new RefreshScheduler({ controller, dataSource, loader, nowUtc: () => NOW });

    // Act
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    scheduler.stop();

    // Assert
    expect(calls.scan).toBe(1);
    expect(controller.getState().refresh.autoIntervalSeconds).toBeNull();
  });

  test('cycleAutoInterval walks off -> 30s -> 1m -> 5m -> 10m -> off', async () => {
    // Arrange
    const { dataSource, controller, loader } = makeFakes();
    controller.start();
    const scheduler = new RefreshScheduler({ controller, dataSource, loader, nowUtc: () => NOW });
    scheduler.start();
    await settle();

    // Act & Assert
    const seen: (number | null)[] = [controller.getState().refresh.autoIntervalSeconds];
    for (let step = 0; step < 5; step += 1) {
      scheduler.cycleAutoInterval();
      seen.push(controller.getState().refresh.autoIntervalSeconds);
    }
    expect(seen).toEqual([null, 30, 60, 300, 600, null]);
    scheduler.stop();
  });

  test('cycling an unlisted interval back to off stops interval runs', async () => {
    // Arrange — sub-second test interval (not part of AUTO_INTERVALS)
    const { calls, dataSource, controller, loader } = makeFakes();
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 0.03,
      nowUtc: () => NOW,
    });

    // Act — interval runs, then one cycle lands on off (indexOf miss -> index 0)
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const scansWhileOn = calls.scan;
    scheduler.cycleAutoInterval();
    expect(controller.getState().refresh.autoIntervalSeconds).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 80));
    scheduler.stop();

    // Assert — interval produced extra scans; none after switching off
    expect(scansWhileOn).toBeGreaterThanOrEqual(2);
    expect(calls.scan).toBe(scansWhileOn);
  });
});

describe('review regressions', () => {
  test('a load in flight during a scan is re-queried afterwards (no stale ready)', async () => {
    // Arrange — a slow report load that straddles a scan completion
    const { calls, dataSource, controller, loader } = makeFakes();
    const slowSource: TuiDataSource = {
      ...dataSource,
      async loadReport(groupBy) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return dataSource.loadReport(groupBy);
      },
    };
    const slowLoader = new TabLoader(controller, slowSource, () => NOW);
    controller.start();

    // Act — load starts, then a scan completes while it is in flight
    slowLoader.loadIfNeeded('overview');
    await new Promise((resolve) => setTimeout(resolve, 10));
    slowLoader.markScanCompleted();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Assert — the pre-scan result triggered a fresh post-scan query
    expect(calls.report).toEqual(['day', 'day']);
    expect(controller.getState().overview.phase).toBe('ready');
    expect(controller.getState().overview.invalidated).toBe(false);
  });

  test('busy scan still re-queries the active tab against the current ledger', async () => {
    // Arrange — first cycle succeeds, later cycles hit the daemon lock
    let locked = false;
    const { calls, dataSource, controller, loader } = makeFakes({
      scanError: () => (locked ? new ScanLockError('/tmp/x.db.lock', 99) : null),
    });
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });
    scheduler.start();
    await settle();

    // Act — manual refresh while the daemon holds the lock
    locked = true;
    scheduler.requestManual();
    await settle();
    scheduler.stop();

    // Assert — busy, but the overview query ran again
    expect(controller.getState().refresh.scanStatus).toBe('busy');
    expect(calls.report).toEqual(['day', 'day']);
  });

  test('hostile error messages are sanitized before entering state', async () => {
    // Arrange
    const ESC = String.fromCharCode(27);
    const { dataSource, controller } = makeFakes();
    const failingSource: TuiDataSource = {
      ...dataSource,
      async loadReport(): Promise<ReportSummary> {
        throw new Error(`boom${ESC}]52;c;payload${String.fromCharCode(7)} end`);
      },
    };
    const loader = new TabLoader(controller, failingSource, () => NOW);
    controller.start();

    // Act
    loader.loadIfNeeded('overview');
    await settle();

    // Assert — no ESC/BEL survives into the error string
    const message = controller.getState().overview.error ?? '';
    expect(message).toBe('boom]52;c;payload end');
  });
});

describe('scan warnings are not disguised as success', () => {
  test('a scan that returned recoverable warnings surfaces as ok-with-warnings', async () => {
    // Arrange — the scan completes but the coordinator reported warnings
    const { dataSource, controller, loader } = makeFakes({ scanWarningTotal: 3 });
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });

    // Act
    scheduler.start();
    await settle();

    // Assert — a warning count reached the state, not a clean 'ok'
    const refresh = controller.getState().refresh;
    expect(refresh.scanStatus).toBe('ok-with-warnings');
    expect(refresh.warningTotal).toBe(3);
    scheduler.stop();
  });

  test('a clean scan stays ok with no warning count', async () => {
    // Arrange
    const { dataSource, controller, loader } = makeFakes({ scanWarningTotal: 0 });
    controller.start();
    const scheduler = new RefreshScheduler({
      controller,
      dataSource,
      loader,
      intervalSeconds: 3600,
      nowUtc: () => NOW,
    });

    // Act
    scheduler.start();
    await settle();

    // Assert
    const refresh = controller.getState().refresh;
    expect(refresh.scanStatus).toBe('ok');
    expect(refresh.warningTotal).toBe(0);
    scheduler.stop();
  });
});
