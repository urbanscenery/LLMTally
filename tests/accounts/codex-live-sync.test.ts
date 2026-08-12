import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readCodexTokens } from '@llmtally/core/accounts/codex.ts';
import { syncActiveCodexCredential } from '@llmtally/core/accounts/codex-live-sync.ts';
import { credentialFingerprint } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

function authJson(accountId: string, refresh: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ email: `${accountId}@test.dev` }),
      access_token: jwt({ exp: NOW + 86_400 }),
      refresh_token: refresh,
      account_id: accountId,
    },
    last_refresh: '2026-08-12T07:00:00.000Z',
  });
}

function harness(stored: string | null = authJson('acc-1', 'rt-1')) {
  const home = makeTempDir();
  const authPath = join(home, 'auth.json');
  const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain() });
  if (stored !== null) {
    vault.put(
      {
        agent: 'codex',
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

describe('syncActiveCodexCredential', () => {
  test('mirrors a rotated live login onto its stored slot', async () => {
    // Arrange — the codex CLI refreshed and moved the refresh token
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-1', 'rt-rotated'));

    // Act
    const outcome = syncActiveCodexCredential({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('synced');
    expect(readCodexTokens(vault.loadCredentials('acc-1') ?? '')?.refreshToken).toBe('rt-rotated');
  });

  test('does nothing when the stored copy already matches', async () => {
    // Arrange
    const { authPath, vault } = harness();
    const same = authJson('acc-1', 'rt-1');
    writeFileSync(authPath, same);
    const before = credentialFingerprint(vault.loadCredentials('acc-1') ?? '');

    // Act
    const outcome = syncActiveCodexCredential({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('not_needed');
    expect(credentialFingerprint(vault.loadCredentials('acc-1') ?? '')).toBe(before);
  });

  test('leaves an unstored login alone — capturing it is the user\'s call', async () => {
    // Arrange — logged in as an account the vault never saw
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-stranger', 'rt-x'));

    // Act
    const outcome = syncActiveCodexCredential({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('not_needed');
    expect(vault.get('acc-stranger')).toBeNull();
    expect(readCodexTokens(vault.loadCredentials('acc-1') ?? '')?.refreshToken).toBe('rt-1');
  });

  test('never overwrites a good backup with an unusable live file', async () => {
    // Arrange — a signed-out / half-written auth.json
    const { authPath, vault } = harness();
    writeFileSync(authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }));

    // Act
    const outcome = syncActiveCodexCredential({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('unavailable');
    expect(readCodexTokens(vault.loadCredentials('acc-1') ?? '')?.refreshToken).toBe('rt-1');
  });

  test('a missing auth.json is not a reason to touch the vault', async () => {
    // Arrange
    const { authPath, vault } = harness();

    // Act
    const outcome = syncActiveCodexCredential({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('unavailable');
    expect(readCodexTokens(vault.loadCredentials('acc-1') ?? '')?.refreshToken).toBe('rt-1');
  });

  test('a live login lifts a stale quarantine', async () => {
    // Arrange — quarantined earlier, but the CLI is using it right now
    const { authPath, vault } = harness();
    vault.markRefreshDeadIfFingerprint(
      'acc-1',
      credentialFingerprint(vault.loadCredentials('acc-1') ?? ''),
      NOW - 10,
    );
    writeFileSync(authPath, authJson('acc-1', 'rt-rotated'));

    // Act
    const outcome = syncActiveCodexCredential({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(outcome).toBe('synced');
    expect(vault.get('acc-1')?.refreshDeadAtUtc).toBeNull();
  });
});
