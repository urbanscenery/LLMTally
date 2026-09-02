import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { credentialFingerprint } from '@llmtally/core/accounts/credentials.ts';
import { readGrokAuthEntries, readStoredGrokEntry } from '@llmtally/core/accounts/grok.ts';
import { syncActiveGrokCredentials } from '@llmtally/core/accounts/grok-live-sync.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const ENTRY_KEY = 'https://auth.x.ai::client-1';

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

function storedDoc(userId: string, refresh: string): string {
  return JSON.stringify({ [ENTRY_KEY]: record(userId, refresh) });
}

function harness(stored: string | null = storedDoc('acc-1', 'rt-1')) {
  const home = makeTempDir();
  const authPath = join(home, 'auth.json');
  const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain() });
  if (stored !== null) {
    vault.put(
      {
        agent: 'grok',
        accountId: 'acc-1',
        email: 'acc-1@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      stored,
    );
  }
  return { authPath, vault };
}

function storedRefreshToken(vault: AccountVault, accountId: string): string | null {
  const stored = vault.loadCredentials('grok', accountId);
  return stored === null ? null : (readStoredGrokEntry(stored)?.refreshToken ?? null);
}

describe('syncActiveGrokCredentials', () => {
  test('mirrors a rotated live login onto its stored slot', () => {
    // Arrange — the grok CLI refreshed and moved the refresh token
    const { authPath, vault } = harness();
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-1', 'rt-rotated') }));

    // Act
    const outcome = syncActiveGrokCredentials({ vault, authPath, nowUtc: NOW });

    // Assert — and the stored copy is still a single-entry document
    expect(outcome).toBe('synced');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('rt-rotated');
    expect(readGrokAuthEntries(vault.loadCredentials('grok', 'acc-1') ?? '')).toHaveLength(1);
  });

  test('mirrors each stored login of a multi-entry file independently', () => {
    // Arrange — two issuer slots, both stored, both rotated
    const { authPath, vault } = harness();
    vault.put(
      {
        agent: 'grok',
        accountId: 'acc-2',
        email: 'acc-2@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      JSON.stringify({ 'https://auth.x.ai::client-2': record('acc-2', 'rt-2') }),
    );
    writeFileSync(
      authPath,
      JSON.stringify({
        [ENTRY_KEY]: record('acc-1', 'rt-1-rotated'),
        'https://auth.x.ai::client-2': record('acc-2', 'rt-2-rotated'),
      }),
    );

    // Act
    const outcome = syncActiveGrokCredentials({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('synced');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('rt-1-rotated');
    expect(storedRefreshToken(vault, 'acc-2')).toBe('rt-2-rotated');
  });

  test('does nothing when the stored copy already matches', () => {
    // Arrange — same generation, formatted differently by the CLI
    const { authPath, vault } = harness();
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-1', 'rt-1') }, null, 2));
    const before = credentialFingerprint(vault.loadCredentials('grok', 'acc-1') ?? '');

    // Act
    const outcome = syncActiveGrokCredentials({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('not_needed');
    expect(credentialFingerprint(vault.loadCredentials('grok', 'acc-1') ?? '')).toBe(before);
  });

  test("leaves an unstored login alone — capturing it is the user's call", () => {
    // Arrange — logged in as an account the vault never saw
    const { authPath, vault } = harness();
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-stranger', 'rt-x') }));

    // Act
    const outcome = syncActiveGrokCredentials({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('not_needed');
    expect(vault.get('grok', 'acc-stranger')).toBeNull();
    expect(storedRefreshToken(vault, 'acc-1')).toBe('rt-1');
  });

  test('never overwrites a good backup with an unusable live file', () => {
    // Arrange — a signed-out / half-written auth.json
    const { authPath, vault } = harness();
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: { email: 'no-tokens@test.dev' } }));

    // Act
    const outcome = syncActiveGrokCredentials({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('unavailable');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('rt-1');
  });

  test('a missing auth.json is not a reason to touch the vault', () => {
    // Arrange
    const { authPath, vault } = harness();

    // Act
    const outcome = syncActiveGrokCredentials({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('unavailable');
    expect(storedRefreshToken(vault, 'acc-1')).toBe('rt-1');
  });

  test('a live login lifts a stale quarantine', () => {
    // Arrange — quarantined earlier, but the CLI is using it right now
    const { authPath, vault } = harness();
    vault.markRefreshDeadIfFingerprint(
      'grok',
      'acc-1',
      credentialFingerprint(vault.loadCredentials('grok', 'acc-1') ?? ''),
      NOW - 10,
    );
    writeFileSync(authPath, JSON.stringify({ [ENTRY_KEY]: record('acc-1', 'rt-rotated') }));

    // Act
    const outcome = syncActiveGrokCredentials({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('synced');
    expect(vault.get('grok', 'acc-1')?.refreshDeadAtUtc).toBeNull();
  });
});
