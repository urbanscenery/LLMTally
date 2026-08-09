import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '@llmtally/core/parsers/claude-code/adapter.ts';
import { CodexAdapter } from '@llmtally/core/parsers/codex/adapter.ts';
import { OpenCodeAdapter } from '@llmtally/core/parsers/opencode/adapter.ts';
import {
  DefaultScanCoordinator,
  LedgerPathConflictError,
} from '@llmtally/core/scan/coordinator.ts';
import { fixturePath, makeTempDir } from '../helpers.ts';
import { createOpenCodeFixtureDb } from '../opencode-fixture.ts';

const CODEX_FIXTURES = [
  'basic.jsonl',
  'replay-parent.jsonl',
  'replay-child.jsonl',
  'turnless.jsonl',
  'tail.jsonl',
] as const;

function setup(): { coordinator: DefaultScanCoordinator; databasePath: string } {
  const codexRoot = join(makeTempDir(), 'sessions');
  mkdirSync(codexRoot, { recursive: true });
  for (const fixture of CODEX_FIXTURES) {
    copyFileSync(fixturePath('codex', fixture), join(codexRoot, `rollout-${fixture}`));
  }
  const coordinator = new DefaultScanCoordinator({
    adapters: [
      new ClaudeCodeAdapter({ rootDirectory: fixturePath('claude-code') }),
      new CodexAdapter({ rootDirectory: codexRoot }),
      new OpenCodeAdapter({ databasePath: createOpenCodeFixtureDb('seed.sql') }),
    ],
    homeDirectory: '/unused',
  });
  return { coordinator, databasePath: join(makeTempDir(), 'ledger.db') };
}

function agentCounts(databasePath: string): Record<string, number> {
  const db = new Database(databasePath, { readonly: true });
  const rows = db
    .query<{ agent: string; n: number }, []>(
      'SELECT agent, COUNT(*) AS n FROM usage_ledger GROUP BY agent ORDER BY agent',
    )
    .all();
  db.close();
  return Object.fromEntries(rows.map((row) => [row.agent, row.n]));
}

describe('multi-adapter scanning', () => {
  test('scans all three agents in one run with per-agent rows', async () => {
    // Arrange
    const { coordinator, databasePath } = setup();

    // Act
    const summary = await coordinator.run({ agent: null, fullRescan: false, databasePath });

    // Assert — codex: basic 2 + replay 2 (1 replayed dup ignored) + turnless 1 + tail 1
    expect(agentCounts(databasePath)).toEqual({ 'claude-code': 9, codex: 6, opencode: 2 });
    expect(summary.insertedRows).toBe(17);
    expect(summary.ignoredRows).toBe(1);
    expect(summary.discoveredFiles).toBe(3 + CODEX_FIXTURES.length + 1);
  });

  test('a second full run inserts nothing new for any agent', async () => {
    // Arrange
    const { coordinator, databasePath } = setup();
    await coordinator.run({ agent: null, fullRescan: false, databasePath });

    // Act
    const second = await coordinator.run({ agent: null, fullRescan: true, databasePath });

    // Assert
    expect(second.insertedRows).toBe(0);
    expect(agentCounts(databasePath)).toEqual({ 'claude-code': 9, codex: 6, opencode: 2 });
  });

  test('agent filters scan exactly one adapter', async () => {
    // Arrange
    const { coordinator, databasePath } = setup();

    // Act
    const codexOnly = await coordinator.run({
      agent: 'codex',
      fullRescan: false,
      databasePath,
    });
    const opencodeOnly = await coordinator.run({
      agent: 'opencode',
      fullRescan: false,
      databasePath,
    });

    // Assert
    expect(codexOnly.insertedRows).toBe(6);
    expect(opencodeOnly.insertedRows).toBe(2);
    expect(agentCounts(databasePath)).toEqual({ codex: 6, opencode: 2 });
  });

  test('refuses a ledger path that is itself a scanned source', async () => {
    // Arrange — pointing --db at the opencode source would chmod it,
    // create -wal/-shm sidecars, and run ledger migrations on it
    const sourceDb = createOpenCodeFixtureDb('seed.sql');
    const coordinator = new DefaultScanCoordinator({
      adapters: [new OpenCodeAdapter({ databasePath: sourceDb })],
      homeDirectory: '/unused',
    });

    // Act & Assert
    expect(
      coordinator.run({ agent: 'opencode', fullRescan: false, databasePath: sourceDb }),
    ).rejects.toBeInstanceOf(LedgerPathConflictError);
  });

  test('refuses a symlinked ledger path that resolves to a scanned source', async () => {
    // Arrange
    const sourceDb = createOpenCodeFixtureDb('seed.sql');
    const { symlinkSync } = await import('node:fs');
    const alias = join(makeTempDir(), 'alias.db');
    symlinkSync(sourceDb, alias);
    const coordinator = new DefaultScanCoordinator({
      adapters: [new OpenCodeAdapter({ databasePath: sourceDb })],
      homeDirectory: '/unused',
    });

    // Act & Assert
    expect(
      coordinator.run({ agent: 'opencode', fullRescan: false, databasePath: alias }),
    ).rejects.toBeInstanceOf(LedgerPathConflictError);
  });

  test('an opencode database target counts as one scanned file', async () => {
    // Arrange
    const { coordinator, databasePath } = setup();

    // Act
    const summary = await coordinator.run({
      agent: 'opencode',
      fullRescan: false,
      databasePath,
    });

    // Assert
    expect(summary.discoveredFiles).toBe(1);
    expect(summary.scannedFiles).toBe(1);
    expect(summary.pendingTails).toBe(0);
  });
});
