import { describe, expect, test } from 'bun:test';

import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { readVaultAccountsQuota } from '@llmtally/core/quota/vault-accounts.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const NOW_MS = NOW * 1000;

function credentials(refresh: string, expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `access-${refresh}`, refreshToken: refresh, expiresAt },
  });
}

function makeVault(entries: readonly { id: string; expiresAt: number }[], active: string | null) {
  const vault = new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain() });
  for (const entry of entries) {
    vault.put(
      {
        agent: 'claude-code',
        accountId: entry.id,
        email: `${entry.id}@test.dev`,
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      credentials(`refresh-${entry.id}`, entry.expiresAt),
    );
  }
  vault.setActive(active);
  return vault;
}

function usageResponse(): Response {
  return new Response(JSON.stringify({ five_hour: { utilization: 33, resets_at: null } }));
}

describe('readVaultAccountsQuota', () => {
  test('reads stored accounts live and skips the active one', async () => {
    // Arrange
    const vault = makeVault(
      [
        { id: 'uuid-active', expiresAt: NOW_MS + 3_600_000 },
        { id: 'uuid-other', expiresAt: NOW_MS + 3_600_000 },
      ],
      'uuid-active',
    );
    const tokens: string[] = [];

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      nowUtc: NOW,
      fetchFn: (_url, init) => {
        tokens.push(String((init?.headers as Record<string, string>).Authorization));
        return Promise.resolve(usageResponse());
      },
    });

    // Assert — the logged-in account is left to the normal live path
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.account).toBe('uuid-other@test.dev');
    expect(snapshots[0]?.windows[0]?.usedPercent).toBe(33);
    expect(tokens).toEqual(['Bearer access-refresh-uuid-other']);
  });

  test('an expired token is renewed and the rotated one is stored', async () => {
    // Arrange — Anthropic rotates the refresh token on every grant
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }], null);
    const calls: string[] = [];

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      nowUtc: NOW,
      fetchFn: (url) => {
        calls.push(String(url));
        if (String(url).includes('oauth/token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ access_token: 'fresh', expires_in: 3600, refresh_token: 'rotated' }),
            ),
          );
        }
        return Promise.resolve(usageResponse());
      },
    });

    // Assert — losing the rotated token would strand the account
    expect(snapshots[0]?.windows).toHaveLength(1);
    const stored = JSON.parse(vault.loadCredentials('uuid-other') ?? '{}');
    expect(stored.claudeAiOauth.refreshToken).toBe('rotated');
    expect(stored.claudeAiOauth.accessToken).toBe('fresh');
    expect(calls[0]).toContain('oauth/token');
  });

  test('read-only mode never calls the token endpoint', async () => {
    // Arrange
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }], null);
    let calls = 0;

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      nowUtc: NOW,
      allowRefresh: false,
      fetchFn: () => {
        calls += 1;
        return Promise.resolve(usageResponse());
      },
    });

    // Assert
    expect(calls).toBe(0);
    expect(snapshots[0]?.warnings[0]).toContain('expired');
  });

  test('a failed renewal explains itself instead of dropping the account', async () => {
    // Arrange
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }], null);

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response('no', { status: 400 })),
    });

    // Assert
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.windows).toHaveLength(0);
    expect(snapshots[0]?.warnings[0]).toContain('could not be renewed');
  });

  test('a rate-limited account is reported as such, not as a generic failure', async () => {
    // Arrange
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS + 3_600_000 }], null);

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response('slow down', { status: 429 })),
    });

    // Assert
    expect(snapshots[0]?.rateLimited).toBe(true);
  });
});
