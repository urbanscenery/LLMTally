import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { DefaultScanCoordinator } from '@llmtally/core/scan/coordinator.ts';
import { UnknownAgentError } from '@llmtally/core/scan/coordinator.ts';
import { ClaudeCodeAdapter } from '@llmtally/core/parsers/claude-code/adapter.ts';
import { acquireScanLock, ScanLockError } from '@llmtally/core/scan/lock.ts';
import { fixturePath, makeTempDir } from '../helpers.ts';

function fixtureCoordinator(): DefaultScanCoordinator {
  return new DefaultScanCoordinator({
    adapters: [new ClaudeCodeAdapter({ rootDirectory: fixturePath('claude-code') })],
    homeDirectory: '/unused',
  });
}

function ledgerRowCount(databasePath: string): number {
  const db = new Database(databasePath, { readonly: true });
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage_ledger').get();
  db.close();
  return row?.n ?? 0;
}

describe('DefaultScanCoordinator idempotency', () => {
  test('first scan ingests all fixture usage records with counts in the summary', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const coordinator = fixtureCoordinator();

    // Act
    const summary = await coordinator.run({
      agent: 'claude-code',
      fullRescan: false,
      databasePath,
    });

    // Assert
    expect(summary.discoveredFiles).toBe(3);
    expect(summary.scannedFiles).toBe(3);
    expect(summary.insertedRows).toBe(9);
    expect(summary.pendingTails).toBe(1);
    expect(summary.malformedLines).toBe(1);
    expect(ledgerRowCount(databasePath)).toBe(9);
  });

  test('rescanning the same sources inserts nothing new', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const coordinator = fixtureCoordinator();
    await coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath });

    // Act
    const second = await coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath });

    // Assert
    expect(second.insertedRows).toBe(0);
    expect(ledgerRowCount(databasePath)).toBe(9);
  });

  test('a forced full rescan only produces ignored duplicates', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const coordinator = fixtureCoordinator();
    await coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath });

    // Act
    const full = await coordinator.run({ agent: 'claude-code', fullRescan: true, databasePath });

    // Assert
    expect(full.insertedRows).toBe(0);
    expect(full.ignoredRows).toBe(9);
    expect(ledgerRowCount(databasePath)).toBe(9);
  });

  test('propagates repository failures instead of hiding them as warnings', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const coordinator = new DefaultScanCoordinator({
      adapters: [new ClaudeCodeAdapter({ rootDirectory: fixturePath('claude-code') })],
      homeDirectory: '/unused',
      openRepository: () => ({
        migrate(): void {},
        getScanState: () => null,
        commitBatch: () => {
          throw new Error('disk I/O error');
        },
        close(): void {},
      }),
    });

    // Act & Assert — a scan that cannot persist rows must fail loudly
    expect(
      coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath }),
    ).rejects.toThrow('disk I/O error');
  });

  test('rejects an agent that has no registered adapter', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const coordinator = fixtureCoordinator();

    // Act & Assert
    expect(
      coordinator.run({ agent: 'no-such-agent', fullRescan: false, databasePath }),
    ).rejects.toBeInstanceOf(UnknownAgentError);
  });
});

describe('scan lock', () => {
  test('a held lock blocks a second scan', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const lock = acquireScanLock(`${databasePath}.lock`);
    const coordinator = fixtureCoordinator();

    // Act & Assert
    expect(
      coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath }),
    ).rejects.toBeInstanceOf(ScanLockError);
    lock.release();
  });

  test('release only removes the lock when this process still owns it', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const { writeFileSync, existsSync, readFileSync } = await import('node:fs');
    const lockPath = `${databasePath}.lock`;
    const lock = acquireScanLock(lockPath);
    writeFileSync(lockPath, '424242');

    // Act — another process replaced the lock; our release must not delete it
    lock.release();

    // Assert
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('424242');
  });

  test('a stale lock from a dead process is taken over', async () => {
    // Arrange
    const databasePath = join(makeTempDir(), 'ledger.db');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${databasePath}.lock`, '999999');
    const coordinator = fixtureCoordinator();

    // Act
    const summary = await coordinator.run({
      agent: 'claude-code',
      fullRescan: false,
      databasePath,
    });

    // Assert
    expect(summary.insertedRows).toBe(9);
  });
});
