import { describe, expect, test } from 'bun:test';
import { appendFileSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '@llmtally/core/parsers/claude-code/adapter.ts';
import { DefaultScanCoordinator } from '@llmtally/core/scan/coordinator.ts';
import type { ScanSummary } from '@llmtally/core/scan/types.ts';
import { fixturePath, makeTempDir } from '../helpers.ts';

function usageLine(uuid: string, timestamp: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: null,
    isSidechain: false,
    sessionId: 'sess-inc',
    cwd: '/tmp/proj',
    timestamp,
    requestId: `req_${uuid}`,
    effort: 'high',
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  })}\n`;
}

function setup(): { root: string; databasePath: string; coordinator: DefaultScanCoordinator } {
  const root = makeTempDir();
  const databasePath = join(makeTempDir(), 'ledger.db');
  const coordinator = new DefaultScanCoordinator({
    adapters: [new ClaudeCodeAdapter({ rootDirectory: root })],
    homeDirectory: '/unused',
  });
  return { root, databasePath, coordinator };
}

async function scan(
  coordinator: DefaultScanCoordinator,
  databasePath: string,
): Promise<ScanSummary> {
  return coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath });
}

describe('incremental scanning', () => {
  test('appended complete lines produce only the new rows', async () => {
    // Arrange
    const { root, databasePath, coordinator } = setup();
    const file = join(root, 'session.jsonl');
    writeFileSync(file, usageLine('inc-1', '2026-08-04T10:00:00.000Z'));
    const first = await scan(coordinator, databasePath);

    // Act
    appendFileSync(file, usageLine('inc-2', '2026-08-04T10:01:00.000Z'));
    const second = await scan(coordinator, databasePath);

    // Assert
    expect(first.insertedRows).toBe(1);
    expect(second.insertedRows).toBe(1);
    expect(second.ignoredRows).toBe(0);
  });

  test('a truncated tail is held back and collected once completed', async () => {
    // Arrange
    const { root, databasePath, coordinator } = setup();
    const file = join(root, 'session.jsonl');
    const complete = usageLine('tail-1', '2026-08-04T10:00:00.000Z');
    const nextLine = usageLine('tail-2', '2026-08-04T10:01:00.000Z');
    writeFileSync(file, complete + nextLine.slice(0, 40));
    const first = await scan(coordinator, databasePath);

    // Act
    appendFileSync(file, nextLine.slice(40));
    const second = await scan(coordinator, databasePath);

    // Assert
    expect(first.insertedRows).toBe(1);
    expect(first.pendingTails).toBe(1);
    expect(second.insertedRows).toBe(1);
    expect(second.pendingTails).toBe(0);
  });

  test('file rotation triggers a cursor reset without duplicating rows', async () => {
    // Arrange
    const { root, databasePath, coordinator } = setup();
    const file = join(root, 'session.jsonl');
    copyFileSync(fixturePath('claude-code', 'basic.jsonl'), file);
    await scan(coordinator, databasePath);

    // Act
    unlinkSync(file);
    copyFileSync(fixturePath('claude-code', 'basic.jsonl'), file);
    const second = await scan(coordinator, databasePath);

    // Assert
    expect(second.warnings.map((warning) => warning.code)).toContain('cursor_reset');
    expect(second.insertedRows).toBe(0);
    expect(second.ignoredRows).toBe(3);
  });

  test('a deleted source keeps its ledger rows and reports a missing file', async () => {
    // Arrange
    const { root, databasePath, coordinator } = setup();
    const file = join(root, 'session.jsonl');
    writeFileSync(file, usageLine('gone-1', '2026-08-04T10:00:00.000Z'));
    await scan(coordinator, databasePath);

    // Act
    unlinkSync(file);
    const second = await scan(coordinator, databasePath);

    // Assert
    expect(second.discoveredFiles).toBe(0);
    expect(second.insertedRows).toBe(0);
    const third = await scan(coordinator, databasePath);
    expect(third.warnings.every((warning) => warning.recoverable)).toBe(true);
  });
});
