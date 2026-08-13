import { beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveActiveClaudeContext } from '@llmtally/core/accounts/active-claude.ts';
import { credentialFingerprint } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import {
  resetLiveCredentialProbes,
  syncActiveClaudeCredential,
  verifyLiveCredentialOwner,
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

describe('probe memo bound', () => {
  test('the memo evicts its oldest lineage instead of growing forever', async () => {
    // Arrange — a long-lived TUI sees a new lineage per token rotation
    resetLiveCredentialProbes();
    let calls = 0;
    const fetchFn = async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ account: { uuid: 'uuid-1' } }));
    };

    // Act — 300 distinct lineages, then re-verify the very first one
    for (let index = 0; index < 300; index += 1) {
      await verifyLiveCredentialOwner({
        accountId: 'uuid-1',
        credentials: JSON.stringify({
          claudeAiOauth: { accessToken: `access-${index}`, refreshToken: `refresh-${index}` },
        }),
        nowUtc: 1_786_400_000,
        fetchFn,
      });
    }
    const before = calls;
    await verifyLiveCredentialOwner({
      accountId: 'uuid-1',
      credentials: JSON.stringify({
        claudeAiOauth: { accessToken: 'access-0', refreshToken: 'refresh-0' },
      }),
      nowUtc: 1_786_400_000,
      fetchFn,
    });

    // Assert — the first lineage aged out of the memo (a re-probe fired),
    // proving the map is bounded rather than append-only
    expect(before).toBe(300);
    expect(calls).toBe(301);
  });
});

describe('foreign mirror to the owner slot', () => {
  beforeEach(() => {
    resetLiveCredentialProbes();
  });

  function storeSeq(texts: (string | null)[]) {
    let index = 0;
    return {
      backend: 'file' as const,
      read: () => texts[Math.min(index++, texts.length - 1)] ?? null,
      write: () => undefined,
      clear: () => undefined,
      touch: () => undefined,
    };
  }

  test('foreign bytes with a managed owner land in the OWNER slot via CAS', async () => {
    // Arrange — config selects acc-1; the live store holds acc-2's
    // rotated bytes; acc-2 has a managed slot with an older generation
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-a');
    storedEntry(vault, 'acc-2', 'refresh-b-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(credentials('refresh-b-new')),
      nowUtc: NOW,
      fetchFn: oracle('acc-2'),
    });

    // Assert — the owner slot adopted the rotation; the selected slot
    // kept its own only surviving refresh token
    expect(result).toBe('foreign_synced');
    expect(storedRefreshToken(vault, 'acc-2')).toBe('refresh-b-new');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('refresh-a');
  });

  test('a quarantined owner slot is revived by the live rotation', async () => {
    // Arrange — acc-2 was refresh-dead; the live login is proof of life
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-a');
    storedEntry(vault, 'acc-2', 'refresh-b-old');
    quarantine(vault, 'acc-2');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(credentials('refresh-b-new')),
      nowUtc: NOW,
      fetchFn: oracle('acc-2'),
    });

    // Assert
    expect(result).toBe('foreign_synced');
    expect(vault.get('claude-code', 'acc-2')?.refreshDeadAtUtc).toBeNull();
  });

  test('bytes that moved between probe and write are not mirrored', async () => {
    // Arrange — the re-read before the CAS sees a different generation
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-a');
    storedEntry(vault, 'acc-2', 'refresh-b-old');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeSeq([credentials('refresh-b-new'), credentials('refresh-b-newer')]),
      nowUtc: NOW,
      fetchFn: oracle('acc-2'),
    });

    // Assert — the verdict bound to bytes that no longer exist
    expect(result).toBe('foreign');
    expect(storedRefreshToken(vault, 'acc-2')).toBe('refresh-b-old');
  });

  test('an unknown owner writes to no claimed slot', async () => {
    // Arrange — the oracle names an account the vault does not manage
    const vault = makeVault();
    storedEntry(vault, 'acc-1', 'refresh-a');
    const context = resolveActiveClaudeContext({ vault, configPath: configWith('acc-1') });

    // Act
    const result = await syncActiveClaudeCredential({
      context,
      vault,
      activeStore: storeWith(credentials('refresh-x')),
      nowUtc: NOW,
      fetchFn: oracle('acc-unmanaged'),
    });

    // Assert
    expect(result).toBe('foreign');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('refresh-a');
  });
});
