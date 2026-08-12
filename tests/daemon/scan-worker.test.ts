import { describe, expect, test } from 'bun:test';

import type { ScanCoordinator, ScanRequest, ScanSummary } from '@llmtally/core/scan/types.ts';
import { runScanWorker } from '@llmtally/tui/scan-worker.ts';

const NOW = 1_786_400_000;

function summaryFor(request: ScanRequest): ScanSummary {
  return {
    agent: request.agent,
    databasePath: request.databasePath,
    discoveredFiles: 3,
    scannedFiles: 2,
    missingFiles: 0,
    insertedRows: 7,
    ignoredRows: 0,
    malformedLines: 0,
    pendingTails: 0,
    warnings: [],
    warningCounts: {},
    warningTotal: 1,
    startedAtUtc: NOW,
    finishedAtUtc: NOW,
  };
}

function coordinator(run: ScanCoordinator['run']): ScanCoordinator {
  return { run };
}

describe('runScanWorker', () => {
  test('runs one incremental scan against the given database and exits 0', async () => {
    // Arrange
    const requests: ScanRequest[] = [];
    const worker = coordinator(async (request) => {
      requests.push(request);
      return summaryFor(request);
    });

    // Act
    const code = await runScanWorker(['--db', '/tmp/worker-ledger.db'], worker);

    // Assert — incremental, every agent, the path launchd passed
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.fullRescan).toBe(false);
    expect(requests[0]?.agent).toBeNull();
    expect(requests[0]?.databasePath).toBe('/tmp/worker-ledger.db');
  });

  test('a failed scan exits 1 instead of pretending it collected', async () => {
    // Arrange
    const worker = coordinator(async () => {
      throw new Error('ledger is locked');
    });

    // Act & Assert
    expect(await runScanWorker(['--db', '/tmp/x.db'], worker)).toBe(1);
  });

  test('unknown or incomplete arguments are a usage error, exit 2', async () => {
    // Arrange — the coordinator must never run on a bad invocation
    const worker = coordinator(async () => {
      throw new Error('must not run');
    });

    // Act & Assert
    expect(await runScanWorker(['--frobnicate'], worker)).toBe(2);
    expect(await runScanWorker(['--db'], worker)).toBe(2);
  });
});
