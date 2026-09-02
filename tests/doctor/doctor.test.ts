import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { runDoctorChecks } from '@llmtally/core/doctor/checks.ts';
import { makeTempDir } from '../helpers.ts';

function isolatedHome(): string {
  return makeTempDir('llmtally-doctor-home-');
}

function healthyLedger(home: string): string {
  const path = join(home, '.llmtally', 'ledger.db');
  const db = openDatabase(path);
  migrate(db);
  db.close();
  return path;
}

describe('runDoctorChecks', () => {
  test('a healthy isolated setup has no failures and skips absent sources', () => {
    // Arrange
    const home = isolatedHome();
    const databasePath = healthyLedger(home);

    // Act
    const checks = runDoctorChecks({ databasePath, homeDirectory: home });
    const byId = new Map(checks.map((check) => [check.id, check]));

    // Assert
    expect(byId.get('ledger.schema')?.status).toBe('pass');
    expect(byId.get('ledger.fts')?.status).toBe('pass');
    expect(byId.get('source.grok')?.status).toBe('skip');
    expect(byId.get('source.cursor-cli')?.status).toBe('skip');
    expect(byId.get('quota.cursor-cli')?.status).toBe('skip');
    expect(byId.get('daemon.plist')?.status).toBe('skip');
    expect(byId.get('quota.antigravity')?.status).toBe('skip');
    expect(checks.filter((check) => check.status === 'fail')).toHaveLength(0);
  });

  test('quota store checks report an expired antigravity token', () => {
    // Arrange — an antigravity account whose access token has expired
    const home = isolatedHome();
    const databasePath = healthyLedger(home);
    const accountDir = join(
      home,
      process.platform === 'darwin'
        ? join('Library', 'Application Support', 'antigravity-usage')
        : join('.config', 'antigravity-usage'),
      'accounts',
      'a@test.dev',
    );
    mkdirSync(accountDir, { recursive: true });
    writeFileSync(
      join(accountDir, 'tokens.json'),
      JSON.stringify({ accessToken: 't', expiresAt: Date.now() - 1000 }),
    );

    // Act
    const checks = runDoctorChecks({ databasePath, homeDirectory: home });
    const byId = new Map(checks.map((check) => [check.id, check]));

    // Assert — warn states carry remediation, and messages leak no emails
    expect(byId.get('quota.antigravity')?.status).toBe('warn');
    expect(byId.get('quota.antigravity')?.remediation).toContain('antigravity-usage refresh');
    expect(byId.get('quota.antigravity')?.message).not.toContain('a@test.dev');
  });

  test('a missing ledger fails with a scan remediation', () => {
    // Arrange
    const home = isolatedHome();

    // Act
    const checks = runDoctorChecks({
      databasePath: join(home, '.llmtally', 'ledger.db'),
      homeDirectory: home,
    });

    // Assert
    const ledger = checks.find((check) => check.id === 'ledger.schema');
    expect(ledger?.status).toBe('fail');
    expect(ledger?.remediation).toContain('restart llmtally');
  });

  test('missing cleanupPeriodDays warns about the 30-day deletion window', () => {
    // Arrange
    const home = isolatedHome();
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{}');

    // Act
    const checks = runDoctorChecks({
      databasePath: healthyLedger(home),
      homeDirectory: home,
    });

    // Assert
    const retention = checks.find((check) => check.id === 'claude.retention');
    expect(retention?.status).toBe('warn');
    expect(retention?.message).toContain('30 days');
  });

  test('a stale scan lock produces a warning, not a failure', () => {
    // Arrange
    const home = isolatedHome();
    const databasePath = healthyLedger(home);
    writeFileSync(`${databasePath}.lock`, '999999');

    // Act
    const checks = runDoctorChecks({ databasePath, homeDirectory: home });

    // Assert
    expect(checks.find((check) => check.id === 'scan.lock')?.status).toBe('warn');
  });

  test('source.cursor-cli warns when projects exist without transcripts', () => {
    const home = isolatedHome();
    mkdirSync(join(home, '.cursor', 'projects'), { recursive: true });
    const checks = runDoctorChecks({ databasePath: healthyLedger(home), homeDirectory: home });
    const source = checks.find((check) => check.id === 'source.cursor-cli');
    expect(source?.status).toBe('warn');
    expect(source?.message).toBe('no agent-transcripts yet');
    expect(source?.remediation).toContain('cursor agent login');
    expect(source?.remediation).toContain('cursor-agent login');
  });

  test('source.cursor-cli passes when an agent-transcripts jsonl exists', () => {
    const home = isolatedHome();
    const dir = join(home, '.cursor', 'projects', 'demo', 'agent-transcripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess.jsonl'), '{}\n');
    const checks = runDoctorChecks({ databasePath: healthyLedger(home), homeDirectory: home });
    expect(checks.find((check) => check.id === 'source.cursor-cli')?.status).toBe('pass');
  });
});
