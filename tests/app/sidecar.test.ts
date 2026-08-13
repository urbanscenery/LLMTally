import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import type { ScanCoordinator, ScanRequest, ScanSummary } from '@llmtally/core/scan/types.ts';

import { createSidecarServer } from '@llmtally/app/sidecar-main.ts';
import { makeTempDir } from '../helpers.ts';

function fakeSummary(request: ScanRequest): ScanSummary {
  return {
    agent: request.agent,
    databasePath: request.databasePath,
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
    startedAtUtc: 1,
    finishedAtUtc: 2,
  };
}

function makeLedger(): string {
  const databasePath = join(makeTempDir(), 'ledger.db');
  const db = openDatabase(databasePath);
  migrate(db);
  db.close();
  return databasePath;
}

async function call(server: { handleLine(line: string): Promise<string | null> }, method: string, params?: unknown): Promise<any> {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return JSON.parse((await server.handleLine(request)) as string);
}

describe('sidecar server', () => {
  test('ping reports the ledger it will serve', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const server = createSidecarServer({ databasePath });

    // Act
    const reply = await call(server, 'ping');

    // Assert
    expect(reply.result).toEqual({ ok: true, databasePath });
  });

  test('scan runs the coordinator as an incremental all-agent pass', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const requests: ScanRequest[] = [];
    const coordinator: ScanCoordinator = {
      run: async (request) => {
        requests.push(request);
        return fakeSummary(request);
      },
    };
    const server = createSidecarServer({ databasePath, coordinator });

    // Act
    const reply = await call(server, 'scan');

    // Assert
    expect(requests).toEqual([{ agent: null, fullRescan: false, databasePath }]);
    expect(reply.result.databasePath).toBe(databasePath);
  });

  test('report aggregates an empty ledger to zero rows, not an error', async () => {
    // Arrange
    const server = createSidecarServer({ databasePath: makeLedger() });

    // Act
    const reply = await call(server, 'report', { groupBy: 'day', noRefresh: true });

    // Assert
    expect(reply.error).toBeUndefined();
    expect(reply.result.totals.rowCount).toBe(0);
    expect(reply.result.buckets).toEqual([]);
  });

  test('overview bundles quota and the day report in one round trip', async () => {
    // Arrange
    const refreshes: boolean[] = [];
    const server = createSidecarServer({
      databasePath: makeLedger(),
      quotaLoader: async ({ allowRefresh }) => {
        refreshes.push(allowRefresh);
        return [];
      },
    });

    // Act
    const reply = await call(server, 'overview', { refresh: false });

    // Assert
    expect(refreshes).toEqual([false]);
    expect(reply.result.quota).toEqual([]);
    expect(reply.result.report.groupBy).toBe('day');
  });

  test('switchAccount refuses agents without a switch transaction', async () => {
    // Arrange — cline has no credential switch in core; the refusal must
    // arrive as an RPC error before any vault state is touched
    const server = createSidecarServer({ databasePath: makeLedger() });

    // Act
    const reply = await call(server, 'switchAccount', { agent: 'cline', selector: 'x' });

    // Assert
    expect(reply.error.message).toContain('not supported');
  });

  test('switchAccount validates its params at the boundary', async () => {
    const server = createSidecarServer({ databasePath: makeLedger() });

    const reply = await call(server, 'switchAccount', { agent: 'codex' });

    expect(reply.error.message).toContain('selector is required');
  });

  test('activeAccounts reports every agent, null when nothing is active', async () => {
    // Arrange — empty vault dir + unreadable claude config + missing
    // codex auth: no agent is logged in, and the reply must still
    // enumerate all six agents
    const dir = makeTempDir();
    const server = createSidecarServer({
      databasePath: makeLedger(),
      vaultDir: join(dir, 'vault'),
      claudeConfigPath: join(dir, 'no-such-claude.json'),
      codexAuthPath: join(dir, 'no-such-auth.json'),
    });

    // Act
    const reply = await call(server, 'activeAccounts');

    // Assert
    expect(reply.error).toBeUndefined();
    expect(Object.keys(reply.result).sort()).toEqual(
      ['antigravity', 'claude-code', 'cline', 'codex', 'grok', 'opencode'],
    );
    expect(Object.values(reply.result).every((value) => value === null)).toBe(true);
  });

  test('activeAccounts derives codex from its live auth.json', async () => {
    // Arrange — no vault marker (never switched through llmtally), but
    // codex itself is logged in: the live file is the truth
    const dir = makeTempDir();
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({
      tokens: { access_token: 'live-token', account_id: 'acct-live' },
    }));
    const server = createSidecarServer({
      databasePath: makeLedger(),
      vaultDir: join(dir, 'vault'),
      claudeConfigPath: join(dir, 'no-such-claude.json'),
      codexAuthPath: authPath,
    });

    // Act
    const reply = await call(server, 'activeAccounts');

    // Assert
    expect(reply.error).toBeUndefined();
    expect(reply.result.codex).toBe('acct-live');
  });

  test('hour bucketing is a valid report grouping', async () => {
    // Arrange — the status sparklines need sub-day resolution
    const server = createSidecarServer({ databasePath: makeLedger() });

    // Act
    const reply = await call(server, 'report', { groupBy: 'hour', noRefresh: true });

    // Assert — empty ledger aggregates cleanly at hour grain
    expect(reply.error).toBeUndefined();
    expect(reply.result.groupBy).toBe('hour');
    expect(reply.result.buckets).toEqual([]);
  });

  test('todayByAgent maps agents to row counts, empty ledger to empty map', async () => {
    // Arrange
    const server = createSidecarServer({ databasePath: makeLedger() });

    // Act
    const reply = await call(server, 'todayByAgent');

    // Assert
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({});
  });

  test('a bad report range comes back as an RPC error, not a crash', async () => {
    const server = createSidecarServer({ databasePath: makeLedger() });

    const reply = await call(server, 'report', { fromDate: 'not-a-date' });

    expect(reply.error).toBeDefined();
  });
});
