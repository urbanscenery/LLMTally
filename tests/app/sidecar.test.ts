import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    // enumerate all seven agents
    const dir = makeTempDir();
    const server = createSidecarServer({
      databasePath: makeLedger(),
      vaultDir: join(dir, 'vault'),
      claudeConfigPath: join(dir, 'no-such-claude.json'),
      codexAuthPath: join(dir, 'no-such-auth.json'),
      opencodeAuthPath: join(dir, 'no-such-opencode.json'),
      grokAuthPath: join(dir, 'no-such-grok.json'),
      antigravityStoreDir: join(dir, 'no-such-antigravity'),
      cursorCliHome: dir,
    });

    // Act
    const reply = await call(server, 'activeAccounts');

    // Assert
    expect(reply.error).toBeUndefined();
    expect(Object.keys(reply.result).sort()).toEqual(
      ['antigravity', 'claude-code', 'cline', 'codex', 'cursor-cli', 'grok', 'opencode'],
    );
    expect(Object.values(reply.result).every((value) => value === null)).toBe(true);
  });

  test('activeAccounts derives grok and opencode from their live stores', async () => {
    // Arrange — no vault markers, but both agents are logged in live
    const dir = makeTempDir();
    const grokPath = join(dir, 'grok-auth.json');
    writeFileSync(grokPath, JSON.stringify({
      'issuer::client': { user_id: 'grok-user-1', email: 'g@test.dev' },
    }));
    const opencodePath = join(dir, 'opencode-auth.json');
    writeFileSync(opencodePath, JSON.stringify({
      'opencode-go': { type: 'api', key: 'sk-live' },
    }));
    const server = createSidecarServer({
      databasePath: makeLedger(),
      vaultDir: join(dir, 'vault'),
      claudeConfigPath: join(dir, 'no-such-claude.json'),
      codexAuthPath: join(dir, 'no-such-auth.json'),
      opencodeAuthPath: opencodePath,
      grokAuthPath: grokPath,
      antigravityStoreDir: join(dir, 'no-such-antigravity'),
    });

    // Act
    const reply = await call(server, 'activeAccounts');

    // Assert
    expect(reply.error).toBeUndefined();
    expect(reply.result.grok).toBe('grok-user-1');
    expect(typeof reply.result.opencode).toBe('string');
  });

  test('activeAccounts derives cursor-cli from cli-config.json', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(
      join(dir, '.cursor', 'cli-config.json'),
      JSON.stringify({ authInfo: { userId: 405, email: 'dev@example.com' } }),
    );
    const server = createSidecarServer({
      databasePath: makeLedger(),
      vaultDir: join(dir, 'vault'),
      claudeConfigPath: join(dir, 'no-such-claude.json'),
      cursorCliHome: dir,
    });
    const reply = await call(server, 'activeAccounts');
    expect(reply.error).toBeUndefined();
    expect(reply.result['cursor-cli']).toBe('405');
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

  test('dayReport nests each agent day-slice with its per-model buckets', async () => {
    // Arrange — two agents on one local day; a UTC noon epoch keeps the
    // local calendar date stable across test-machine timezones
    const databasePath = makeLedger();
    const epoch = Date.UTC(2026, 7, 10, 12) / 1000;
    const date = localDayKeyOf(epoch);
    const db = openDatabase(databasePath);
    const insert = db.prepare(
      `INSERT INTO usage_ledger
        (ts_utc, agent, provider, model, natural_id, parser_version,
         input_tokens, output_tokens, cache_write, cache_read, reasoning_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, ?)`,
    );
    insert.run(epoch, 'claude-code', 'anthropic', 'claude-fable-5', 'd1', 100, 10, null);
    insert.run(epoch, 'codex', 'openai', 'gpt-5.5', 'd2', 200, 20, null);
    insert.run(epoch, 'codex', 'openai', 'gpt-5.5-mini', 'd3', 50, 5, null);
    db.close();
    const server = createSidecarServer({ databasePath });

    // Act
    const reply = await call(server, 'dayReport', { date });

    // Assert — agents at the top, that agent's models (only) nested
    expect(reply.error).toBeUndefined();
    const agents = reply.result.agents.buckets.map((bucket: { key: string }) => bucket.key).sort();
    expect(agents).toEqual(['claude-code', 'codex']);
    const codexModels = reply.result.modelsByAgent['codex'].buckets
      .map((bucket: { key: string }) => bucket.key)
      .sort();
    expect(codexModels).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    expect(
      reply.result.modelsByAgent['claude-code'].buckets.map((bucket: { key: string }) => bucket.key),
    ).toEqual(['claude-fable-5']);
  });

  test('dayReport rejects a malformed date and requires one', async () => {
    const server = createSidecarServer({ databasePath: makeLedger() });

    expect((await call(server, 'dayReport', { date: '2026-13-40' })).error).toBeDefined();
    expect((await call(server, 'dayReport', {})).error).toBeDefined();
  });
});

/** Local calendar day of a UTC epoch — matches SQLite's localtime bucketing. */
function localDayKeyOf(epochSeconds: number): string {
  const value = new Date(epochSeconds * 1000);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}
