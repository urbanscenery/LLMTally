import { describe, expect, test } from 'bun:test';

import type { ActiveClaudeContext } from '@llmtally/core/accounts/active-claude.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { KeychainError, createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import type { KeychainPort } from '@llmtally/core/accounts/keychain.ts';
import { LLMTALLY_USER_AGENT } from '@llmtally/core/version.ts';
import { readVaultAccountsQuota } from '@llmtally/core/quota/vault-accounts.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const NOW_MS = NOW * 1000;

function credentials(refresh: string, expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `access-${refresh}`, refreshToken: refresh, expiresAt },
  });
}

function makeVault(entries: readonly { id: string; expiresAt: number }[]) {
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
  return vault;
}

function identified(accountUuid: string): ActiveClaudeContext {
  return {
    status: 'identified',
    source: 'claude_config',
    activeAccountId: accountUuid,
    identity: { accountUuid, email: `${accountUuid}@test.dev`, organizationUuid: null, organizationName: null },
  };
}

const SIGNED_OUT: ActiveClaudeContext = {
  status: 'signed_out',
  source: 'none',
  activeAccountId: null,
  identity: null,
};

function usageResponse(): Response {
  return new Response(JSON.stringify({ five_hour: { utilization: 33, resets_at: null } }));
}

describe('readVaultAccountsQuota', () => {
  test('an unanswerable keychain degrades to unavailable, not "no stored credentials"', async () => {
    // Arrange — the vault keychain is locked/timing out; the entry
    // exists (file-backend fallback) but reads throw
    const erroring: KeychainPort = {
      available: true,
      read: () => ({ kind: 'error', message: 'security timed out' }),
      write: () => {
        throw new KeychainError('security timed out');
      },
      remove: () => undefined,
      findAccount: () => null,
    };
    const dir = makeTempDir();
    const healthy = new AccountVault({ dir, keychain: createMemoryKeychain(false) });
    healthy.put(
      {
        agent: 'claude-code',
        accountId: 'uuid-1',
        email: 'uuid-1@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      credentials('refresh-1', NOW_MS + 3_600_000),
    );
    const vault = new AccountVault({ dir, keychain: erroring });
    const calls: string[] = [];

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: (url) => {
        calls.push(String(url));
        return Promise.resolve(usageResponse());
      },
    });

    // Assert — the poll survives, says why, and spends no requests
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.failure?.kind).toBe('unavailable');
    expect(snapshots[0]?.warnings[0]).toMatch(/unreadable right now.*will retry/);
    expect(calls).toEqual([]);
  });

  test('reads stored accounts live and skips the one the live login names', async () => {
    // Arrange — the context (not any registry marker) decides "active"
    const vault = makeVault([
      { id: 'uuid-active', expiresAt: NOW_MS + 3_600_000 },
      { id: 'uuid-other', expiresAt: NOW_MS + 3_600_000 },
    ]);
    const tokens: string[] = [];

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: identified('uuid-active'),
      nowUtc: NOW,
      fetchFn: (_url, init) => {
        tokens.push(String((init?.headers as Record<string, string>).Authorization));
        return Promise.resolve(usageResponse());
      },
    });

    // Assert — the logged-in account is left to the normal live path
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.account).toBe('uuid-other@test.dev');
    expect(snapshots[0]?.accountId).toBe('uuid-other');
    expect(snapshots[0]?.windows[0]?.usedPercent).toBe(33);
    expect(tokens).toEqual(['Bearer access-refresh-uuid-other']);
  });

  test('an expired token is renewed and the rotated one is stored', async () => {
    // Arrange — Anthropic rotates the refresh token on every grant
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);
    const calls: string[] = [];
    let tokenRequestUserAgent: string | undefined;

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: (url, init) => {
        calls.push(String(url));
        if (String(url).includes('oauth/token')) {
          tokenRequestUserAgent = (init?.headers as Record<string, string>)['User-Agent'];
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
    const stored = JSON.parse(vault.loadCredentials('claude-code', 'uuid-other') ?? '{}');
    expect(stored.claudeAiOauth.refreshToken).toBe('rotated');
    expect(stored.claudeAiOauth.accessToken).toBe('fresh');
    expect(calls[0]).toContain('oauth/token');
    expect(tokenRequestUserAgent).toBe(LLMTALLY_USER_AGENT);
  });

  test('read-only mode never calls the token endpoint', async () => {
    // Arrange
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);
    let calls = 0;

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
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

  test('an invalid_grant rejection quarantines the entry and stops further token calls', async () => {
    // Arrange — the server says this refresh lineage is dead
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);
    let tokenCalls = 0;
    const rejecting = () => {
      tokenCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      );
    };

    // Act — two polling cycles
    const first = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: rejecting,
    });
    const second = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW + 180,
      fetchFn: rejecting,
    });

    // Assert — one token call total; the entry is marked and explains itself
    expect(tokenCalls).toBe(1);
    expect(first[0]?.warnings[0]).toContain('re-login');
    expect(second[0]?.warnings[0]).toContain('/login as this account');
    expect(vault.get('claude-code', 'uuid-other')?.refreshDeadAtUtc).toBe(NOW);
  });

  test.each([400, 401, 403])(
    'a %i with a permanent marker quarantines the lineage, whatever the casing',
    async (status) => {
      // Arrange — only the token endpoint's own refusal statuses are permanent
      const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);

      // Act
      await readVaultAccountsQuota({
        vault,
        activeContext: SIGNED_OUT,
        nowUtc: NOW,
        fetchFn: () =>
          Promise.resolve(new Response('{"error":"INVALID_GRANT"}', { status })),
      });

      // Assert
      expect(vault.get('claude-code', 'uuid-other')?.refreshDeadAtUtc).toBe(NOW);
    },
  );

  test('a 429 is never permanent even when the body carries a grant marker', async () => {
    // Arrange — throttling wins over the marker; 429 is not a grant verdict
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);

    // Act
    await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: () =>
        Promise.resolve(new Response('{"error":"invalid_grant"}', { status: 429 })),
    });

    // Assert
    expect(vault.get('claude-code', 'uuid-other')?.refreshDeadAtUtc).toBeNull();
  });

  test('an invalid_client marker on an allowlisted status quarantines too', async () => {
    // Arrange — the other permanent code, on a 401
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);

    // Act
    await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: () =>
        Promise.resolve(new Response('{"error":"invalid_client"}', { status: 401 })),
    });

    // Assert
    expect(vault.get('claude-code', 'uuid-other')?.refreshDeadAtUtc).toBe(NOW);
  });

  test('a plain-text (non-JSON) marker still quarantines on an allowlisted status', async () => {
    // Arrange — the classifier matches the raw body, JSON or not
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);

    // Act
    await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: () =>
        Promise.resolve(new Response('error=invalid_grant; lineage revoked', { status: 403 })),
    });

    // Assert
    expect(vault.get('claude-code', 'uuid-other')?.refreshDeadAtUtc).toBe(NOW);
  });

  test.each([409, 418, 422, 500, 503])(
    'a %i stays transient even with a permanent marker — a middlebox never quarantines a live lineage',
    async (status) => {
      // Arrange — a proxy/gateway/WAF speaking a non-grant status
      const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);
      let tokenCalls = 0;
      const rejecting = () => {
        tokenCalls += 1;
        return Promise.resolve(new Response('{"error":"invalid_grant"}', { status }));
      };

      // Act — two polling cycles
      const first = await readVaultAccountsQuota({
        vault,
        activeContext: SIGNED_OUT,
        nowUtc: NOW,
        fetchFn: rejecting,
      });
      const second = await readVaultAccountsQuota({
        vault,
        activeContext: SIGNED_OUT,
        nowUtc: NOW + 180,
        fetchFn: rejecting,
      });

      // Assert — retried each cycle, never marked dead
      expect(tokenCalls).toBe(2);
      expect(first[0]?.warnings[0]).toContain('will retry');
      expect(second[0]?.warnings[0]).toContain('will retry');
      expect(vault.get('claude-code', 'uuid-other')?.refreshDeadAtUtc).toBeNull();
    },
  );

  test('a transient failure is retried next cycle, never quarantined', async () => {
    // Arrange — 5xx and a 4xx without a permanent marker
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);
    let tokenCalls = 0;

    // Act
    const first = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: () => {
        tokenCalls += 1;
        return Promise.resolve(new Response('server error', { status: 500 }));
      },
    });
    const second = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW + 180,
      fetchFn: () => {
        tokenCalls += 1;
        return Promise.resolve(new Response('bad request without marker', { status: 400 }));
      },
    });

    // Assert — retried each cycle, no quarantine
    expect(tokenCalls).toBe(2);
    expect(first[0]?.warnings[0]).toContain('will retry');
    expect(second[0]?.warnings[0]).toContain('will retry');
    expect(vault.get('claude-code', 'uuid-other')?.refreshDeadAtUtc).toBeNull();
  });

  test('a quarantined account with a still-usable access token is read anyway', async () => {
    // Arrange — quarantine only blocks the token endpoint, not usage
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS + 3_600_000 }]);
    vault.markRefreshDeadIfFingerprint(
      'claude-code',
      'uuid-other',
      // fingerprint of the stored credentials (refresh-token hash)
      (await import('@llmtally/core/accounts/credentials.ts')).credentialFingerprint(
        vault.loadCredentials('claude-code', 'uuid-other') ?? '',
      ),
      NOW - 60,
    );
    const urls: string[] = [];

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: (url) => {
        urls.push(String(url));
        return Promise.resolve(usageResponse());
      },
    });

    // Assert
    expect(snapshots[0]?.windows).toHaveLength(1);
    expect(urls.every((url) => url.includes('oauth/usage'))).toBe(true);
  });

  test('a stale refresh cannot clobber credentials that changed mid-flight', async () => {
    // Arrange — while our refresh is in the air, a re-capture stores a
    // newer generation (e.g. the user logged in and switched)
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);
    const newer = credentials('newer-generation', NOW_MS + 3_600_000);

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: (url, init) => {
        if (String(url).includes('oauth/token')) {
          // the interleaving write happens before the response lands
          // (e.g. a capture/switch in another process storing a fresh login)
          vault.put(
            {
              agent: 'claude-code',
              accountId: 'uuid-other',
              email: 'uuid-other@test.dev',
              organizationUuid: null,
              organizationName: null,
              alias: null,
              addedAtUtc: NOW,
              refreshDeadAtUtc: null,
            },
            newer,
          );
          return Promise.resolve(
            new Response(
              JSON.stringify({ access_token: 'stale', expires_in: 3600, refresh_token: 'stale-r' }),
            ),
          );
        }
        const auth = (init?.headers as Record<string, string>).Authorization;
        expect(auth).toBe('Bearer access-newer-generation');
        return Promise.resolve(usageResponse());
      },
    });

    // Assert — the newer generation survived; the stale rotation was dropped
    const stored = JSON.parse(vault.loadCredentials('claude-code', 'uuid-other') ?? '{}');
    expect(stored.claudeAiOauth.refreshToken).toBe('newer-generation');
    expect(snapshots[0]?.windows).toHaveLength(1);
  });

  test('a failed renewal explains itself instead of dropping the account', async () => {
    // Arrange
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS - 1000 }]);

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response('no', { status: 502 })),
    });

    // Assert
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.windows).toHaveLength(0);
    expect(snapshots[0]?.warnings[0]).toContain('will retry');
  });

  test('a rate-limited account is reported as such, not as a generic failure', async () => {
    // Arrange
    const vault = makeVault([{ id: 'uuid-other', expiresAt: NOW_MS + 3_600_000 }]);

    // Act
    const snapshots = await readVaultAccountsQuota({
      vault,
      activeContext: SIGNED_OUT,
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response('slow down', { status: 429 })),
    });

    // Assert
    expect(snapshots[0]?.rateLimited).toBe(true);
    expect(snapshots[0]?.failure?.kind).toBe('rate_limited');
  });
});
