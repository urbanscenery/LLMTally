import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGrokAuthEntries, readStoredGrokEntry } from '@llmtally/core/accounts/grok.ts';
import { switchGrokAccount } from '@llmtally/core/accounts/grok-switch.ts';
import type { GrokAuthLockAcquire } from '@llmtally/core/accounts/grok-switch.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const ENTRY_KEY = 'https://auth.x.ai::client-1';
const OTHER_ISSUER_KEY = 'https://sso.corp.example::client-9';

function record(userId: string, refresh: string): Record<string, unknown> {
  return {
    key: `access-of-${refresh}`,
    auth_mode: 'oidc',
    user_id: userId,
    email: `${userId}@test.dev`,
    refresh_token: refresh,
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'client-1',
    expires_at: '2026-08-16T20:46:50.000Z',
  };
}

function putAccount(vault: AccountVault, userId: string, refresh: string): void {
  vault.put(
    {
      agent: 'grok',
      accountId: userId,
      email: `${userId}@test.dev`,
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
    },
    JSON.stringify({ [ENTRY_KEY]: record(userId, refresh) }),
  );
}

function harness() {
  const home = makeTempDir();
  const authPath = join(home, 'auth.json');
  const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain() });
  const lockEvents: string[] = [];
  const acquireLock: GrokAuthLockAcquire = async (lockPath) => {
    lockEvents.push(`acquire:${lockPath}`);
    return {
      release() {
        lockEvents.push('release');
      },
    };
  };
  return { authPath, vault, lockEvents, acquireLock };
}

describe('switchGrokAccount', () => {
  test('splices the target entry and preserves other issuer slots untouched', async () => {
    // Arrange — acc-a live (plus an unrelated corp login), acc-b vaulted
    const { authPath, vault, lockEvents, acquireLock } = harness();
    putAccount(vault, 'acc-a', 'rt-a');
    putAccount(vault, 'acc-b', 'rt-b');
    const corpRecord = { ...record('corp-user', 'rt-corp'), oidc_issuer: 'https://sso.corp.example' };
    writeFileSync(
      authPath,
      JSON.stringify({ [ENTRY_KEY]: record('acc-a', 'rt-a'), [OTHER_ISSUER_KEY]: corpRecord }),
    );

    // Act
    const result = await switchGrokAccount('acc-b', { vault, authPath, nowUtc: NOW, acquireLock });

    // Assert — target active, corp slot byte-identical, outgoing backed up
    const entries = readGrokAuthEntries(readFileSync(authPath, 'utf8'));
    expect(entries.find((entry) => entry.entryKey === ENTRY_KEY)?.accountId).toBe('acc-b');
    expect(entries.find((entry) => entry.entryKey === OTHER_ISSUER_KEY)?.record).toEqual(corpRecord);
    expect(result.outgoing).toBe('own');
    expect(
      readStoredGrokEntry(vault.loadCredentials('grok', 'acc-a') ?? '')?.refreshToken,
    ).toBe('rt-a');
    expect(lockEvents).toEqual([`acquire:${authPath}.lock`, 'release']);
  });

  test('resolves the target by email and by alias', async () => {
    // Arrange
    const { authPath, vault, acquireLock } = harness();
    putAccount(vault, 'acc-a', 'rt-a');
    putAccount(vault, 'acc-b', 'rt-b');
    vault.setAlias('grok', 'acc-b', 'work');
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-a', 'rt-a') }));

    // Act & Assert
    const byAlias = await switchGrokAccount('work', { vault, authPath, nowUtc: NOW, acquireLock });
    expect(byAlias.target.accountId).toBe('acc-b');
    const byEmail = await switchGrokAccount('acc-a@test.dev', { vault, authPath, nowUtc: NOW, acquireLock });
    expect(byEmail.target.accountId).toBe('acc-a');
  });

  test('is a no-op when the target is already live', async () => {
    // Arrange
    const { authPath, vault, acquireLock } = harness();
    putAccount(vault, 'acc-a', 'rt-a');
    const live = JSON.stringify({ [ENTRY_KEY]: record('acc-a', 'rt-a-rotated') });
    writeFileSync(authPath, live);

    // Act
    const result = await switchGrokAccount('acc-a', { vault, authPath, nowUtc: NOW, acquireLock });

    // Assert — the rotated live bytes were not clobbered
    expect(result.outgoing).toBe('absent');
    expect(readFileSync(authPath, 'utf8')).toBe(live);
  });

  test('captures and stashes an outgoing login the vault never saw', async () => {
    // Arrange — live login is a stranger to the vault
    const { authPath, vault, acquireLock } = harness();
    putAccount(vault, 'acc-b', 'rt-b');
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-stranger', 'rt-x') }));

    // Act
    const result = await switchGrokAccount('acc-b', { vault, authPath, nowUtc: NOW, acquireLock });

    // Assert — preserved as switchable AND as unclaimed evidence
    expect(result.outgoing).toBe('unclaimed');
    expect(result.stashId).not.toBeNull();
    expect(
      readStoredGrokEntry(vault.loadCredentials('grok', 'acc-stranger') ?? '')?.refreshToken,
    ).toBe('rt-x');
    expect(existsSync(join(vault.directory, 'unclaimed', `${result.stashId}.cred`))).toBe(true);
  });

  test('aborts when auth.json changes between the read and the write', async () => {
    // Arrange — a writer that does not speak the lock protocol races us
    const { authPath, vault, acquireLock } = harness();
    putAccount(vault, 'acc-a', 'rt-a');
    putAccount(vault, 'acc-b', 'rt-b');
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-a', 'rt-a') }));
    const racedBytes = JSON.stringify({ [ENTRY_KEY]: record('acc-a', 'rt-a-racing') });

    // Act & Assert
    await expect(
      switchGrokAccount('acc-b', {
        vault,
        authPath,
        nowUtc: NOW,
        acquireLock,
        beforeWrite: () => writeFileSync(authPath, racedBytes),
      }),
    ).rejects.toThrow(/changed while switching/);
    expect(readFileSync(authPath, 'utf8')).toBe(racedBytes);
  });

  test('refuses a quarantined target and a target with no stored bytes', async () => {
    // Arrange
    const { authPath, vault, acquireLock } = harness();
    putAccount(vault, 'acc-dead', 'rt-dead');
    const stored = vault.loadCredentials('grok', 'acc-dead') ?? '';
    const { credentialFingerprint } = await import('@llmtally/core/accounts/credentials.ts');
    vault.markRefreshDeadIfFingerprint('grok', 'acc-dead', credentialFingerprint(stored), NOW);
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-a', 'rt-a') }));

    // Act & Assert
    await expect(
      switchGrokAccount('acc-dead', { vault, authPath, nowUtc: NOW, acquireLock }),
    ).rejects.toThrow(/was rejected/);
    await expect(
      switchGrokAccount('acc-unknown', { vault, authPath, nowUtc: NOW, acquireLock }),
    ).rejects.toThrow(/no stored grok account/);
  });

  test('activates a stored login even when grok is signed out entirely', async () => {
    // Arrange — no auth.json at all
    const { authPath, vault, acquireLock } = harness();
    putAccount(vault, 'acc-b', 'rt-b');

    // Act
    const result = await switchGrokAccount('acc-b', { vault, authPath, nowUtc: NOW, acquireLock });

    // Assert
    expect(result.outgoing).toBe('absent');
    const entries = readGrokAuthEntries(readFileSync(authPath, 'utf8'));
    expect(entries.find((entry) => entry.entryKey === ENTRY_KEY)?.accountId).toBe('acc-b');
  });
});
