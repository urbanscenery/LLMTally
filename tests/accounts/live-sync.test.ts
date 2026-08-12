import { beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveActiveClaudeContext } from '@llmtally/core/accounts/active-claude.ts';
import { credentialFingerprint } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import {
  resetLiveCredentialProbes,
  syncActiveClaudeCredential,
} from '@llmtally/core/accounts/live-sync.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function credentials(refreshToken: string, accessToken = 'access-1'): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt: 9e12 },
  });
}

function configWith(accountUuid: string): string {
  const path = join(makeTempDir(), '.claude.json');
  writeFileSync(path, JSON.stringify({ projects: {}, oauthAccount: { accountUuid } }));
  return path;
}

function makeVault(): AccountVault {
  return new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain() });
}

function storedEntry(vault: AccountVault, accountId: string, refreshToken: string): void {
  vault.put(
    {
      agent: 'claude-code',
      accountId,
      email: `${accountId}@test.dev`,
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
    },
    credentials(refreshToken),
  );
}

function quarantine(vault: AccountVault, accountId: string): void {
  const stored = vault.loadCredentials('claude-code', accountId) ?? '';
  vault.markRefreshDeadIfFingerprint('claude-code', accountId, credentialFingerprint(stored), NOW - 100);
}

function storeWith(text: string | null) {
  return {
    backend: 'file' as const,
    read: () => text,
    write: () => undefined,
    clear: () => undefined,
    touch: () => undefined,
  };
}

/** The profile oracle, answering with whichever account id is passed. */
function oracle(accountUuid: string | null, calls: string[] = []) {
  return (url: string): Promise<Response> => {
    calls.push(url);
    if (accountUuid === null) {
      return Promise.resolve(new Response('nope', { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ account: { uuid: accountUuid, email: 'me@test.dev' } }), {
        status: 200,
      }),
    );
  };
}

function storedRefreshToken(vault: AccountVault, accountId: string): string {
  return JSON.parse(vault.loadCredentials('claude-code', accountId) ?? '{}').claudeAiOauth.refreshToken;
}

describe('syncActiveClaudeCredential', () => {
  beforeEach(() => {
    resetLiveCredentialProbes();
  });

  test('adopts the generation Claude Code rotated to while the account was active', async () => {
    // Arrange — the vault still holds the predecessor the server consumed
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });
    const calls: string[] = [];

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(credentials('refresh-new', 'access-new')),
      nowUtc: NOW,
      fetchFn: oracle('acc-1', calls),
    });

    // Assert
    expect(result).toBe('synced');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('refresh-new');
    expect(calls[0]).toContain('/api/oauth/profile');
  });

  test('lifts a stale quarantine when the live lineage moved on', async () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    quarantine(vault, 'acc-1');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(credentials('refresh-new')),
      nowUtc: NOW,
      fetchFn: oracle('acc-1'),
    });

    // Assert
    expect(result).toBe('synced');
    expect(vault.get('claude-code', 'acc-1')?.refreshDeadAtUtc).toBeNull();
  });

  test('refuses to write a credential that belongs to another account', async () => {
    // Arrange — the config still names acc-1 but the live store moved on
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(credentials('someone-elses-refresh')),
      nowUtc: NOW,
      fetchFn: oracle('acc-2'),
    });

    // Assert — the slot keeps its only surviving refresh token
    expect(result).toBe('foreign');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('refresh-old');
  });

  test('leaves the vault alone when ownership cannot be resolved', async () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(credentials('refresh-new')),
      nowUtc: NOW,
      fetchFn: oracle(null),
    });

    // Assert
    expect(result).toBe('unverified');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('refresh-old');
  });

  test('probes a lineage once and answers the steady state from memory', async () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });
    const calls: string[] = [];
    const live = credentials('refresh-new');

    // Act — first sync adopts, second sees no drift at all
    await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(live),
      nowUtc: NOW,
      fetchFn: oracle('acc-1', calls),
    });
    const second = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(live),
      nowUtc: NOW + 1,
      fetchFn: oracle('acc-1', calls),
    });

    // Assert
    expect(second).toBe('not_needed');
    expect(calls).toHaveLength(1);
  });

  test('does not re-probe an unresolvable lineage on every poll', async () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });
    const calls: string[] = [];
    const live = credentials('refresh-new');
    const input = {
      context,
      vault,
      activeStore: storeWith(live),
      fetchFn: oracle(null, calls),
    };

    // Act — three polls a minute apart inside the cooldown
    await syncActiveClaudeCredential({ ...input, nowUtc: NOW });
    await syncActiveClaudeCredential({ ...input, nowUtc: NOW + 60 });
    await syncActiveClaudeCredential({ ...input, nowUtc: NOW + 120 });
    // and one after it expires
    await syncActiveClaudeCredential({ ...input, nowUtc: NOW + 600 });

    // Assert
    expect(calls).toHaveLength(2);
  });

  test('never overwrites a stored copy with a partial or wiped live blob', async () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });
    const accessOnly = JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: '' } });
    const wiped = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } });

    // Act & Assert
    for (const live of [accessOnly, wiped, null]) {
      expect(
        await syncActiveClaudeCredential({
          context,
          vault,
          activeStore: storeWith(live),
          nowUtc: NOW,
          fetchFn: oracle('acc-1'),
        }),
      ).toBe('unavailable');
    }
    expect(storedRefreshToken(vault, 'acc-1')).toBe('refresh-old');
  });

  test('does nothing when the active account is not stored or not identified', async () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-old');
    const unknown = resolveActiveClaudeContext({ vault, configPath: configWith('not-stored') });
    const unreadable = resolveActiveClaudeContext({
      vault,
      configPath: join(makeTempDir(), 'absent.json'),
    });

    // Act & Assert
    for (const context of [unknown, unreadable]) {
      expect(
        await syncActiveClaudeCredential({
          context,
          vault,
          activeStore: storeWith(credentials('refresh-new')),
          nowUtc: NOW,
          fetchFn: oracle('acc-1'),
        }),
      ).toBe('not_needed');
    }
  });
});
