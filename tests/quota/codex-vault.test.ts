import { describe, expect, test } from 'bun:test';

import { codexCredentialFingerprint, readCodexTokens } from '@llmtally/core/accounts/codex.ts';
import { credentialFingerprint } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { readVaultCodexQuota } from '@llmtally/core/quota/codex-vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const USAGE_URL = 'https://usage.test/wham/usage';
const TOKEN_URL = 'https://token.test/oauth/token';

/** A JWT whose payload carries only what the readers look at. */
function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

function authJson(accountId: string, refresh: string, expUtc: number): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ email: `${accountId}@test.dev` }),
      access_token: jwt({ exp: expUtc }),
      refresh_token: refresh,
      account_id: accountId,
    },
    last_refresh: '2026-08-12T07:00:00.000Z',
  });
}

function makeVault(
  entries: readonly { readonly id: string; readonly expUtc: number }[],
): AccountVault {
  const vault = new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain() });
  for (const entry of entries) {
    vault.put(
      {
        agent: 'codex',
        accountId: entry.id,
        email: `${entry.id}@test.dev`,
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      authJson(entry.id, `rt-${entry.id}`, entry.expUtc),
    );
  }
  return vault;
}

/** Marks a stored lineage dead, keyed on the bytes the vault holds now. */
function quarantine(vault: AccountVault, accountId: string): void {
  vault.markRefreshDeadIfFingerprint(
    accountId,
    credentialFingerprint(vault.loadCredentials(accountId) ?? ''),
    NOW - 10,
  );
}

function usageResponse(): Response {
  return new Response(
    JSON.stringify({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 600 },
      },
    }),
  );
}

describe('readVaultCodexQuota', () => {
  test('reads a stored account with its own token and skips the active one', async () => {
    // Arrange — both tokens are healthy; only the inactive one is ours to read
    const vault = makeVault([
      { id: 'acc-active', expUtc: NOW + 86_400 },
      { id: 'acc-other', expUtc: NOW + 86_400 },
    ]);
    const seen: { url: string; auth: string | null; account: string | null }[] = [];

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: 'acc-active',
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(url),
          auth: headers.get('authorization'),
          account: headers.get('chatgpt-account-id'),
        });
        return usageResponse();
      },
    });

    // Assert — one reading, scoped to the stored account by header
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.accountId).toBe('acc-other');
    expect(snapshots[0]?.account).toBe('acc-other@test.dev');
    expect(snapshots[0]?.windows[0]?.usedPercent).toBe(42);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(USAGE_URL);
    expect(seen[0]?.account).toBe('acc-other');
  });

  test('refreshes an expired token and persists the rotated generation', async () => {
    // Arrange — the stored access token died yesterday
    const vault = makeVault([{ id: 'acc-1', expUtc: NOW - 60 }]);
    const before = vault.loadCredentials('acc-1') ?? '';
    const calls: string[] = [];

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async (url, init) => {
        calls.push(String(url));
        if (String(url) === TOKEN_URL) {
          const body = JSON.parse(String(init?.body));
          expect(body.grant_type).toBe('refresh_token');
          expect(body.refresh_token).toBe('rt-acc-1');
          expect(typeof body.client_id).toBe('string');
          return new Response(
            JSON.stringify({
              access_token: jwt({ exp: NOW + 86_400 }),
              refresh_token: 'rt-rotated',
              id_token: jwt({ email: 'acc-1@test.dev' }),
            }),
          );
        }
        return usageResponse();
      },
    });

    // Assert — the reading succeeded and the vault holds the new lineage
    expect(calls).toEqual([TOKEN_URL, USAGE_URL]);
    expect(snapshots[0]?.windows[0]?.usedPercent).toBe(42);
    const after = vault.loadCredentials('acc-1') ?? '';
    expect(readCodexTokens(after)?.refreshToken).toBe('rt-rotated');
    expect(codexCredentialFingerprint(after)).not.toBe(codexCredentialFingerprint(before));
    // the rotated file must stay something the codex CLI can read back
    expect(JSON.parse(after).auth_mode).toBe('chatgpt');
    expect(JSON.parse(after).last_refresh).toBe(new Date(NOW * 1000).toISOString());
  });

  test('quarantines the account when the token endpoint rejects the grant', async () => {
    // Arrange
    const vault = makeVault([{ id: 'acc-1', expUtc: NOW - 60 }]);

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });

    // Assert
    expect(vault.get('acc-1')?.refreshDeadAtUtc).toBe(NOW);
    expect(snapshots[0]?.failure?.kind).toBe('unavailable');
    expect(snapshots[0]?.warnings.join(' ')).toContain('invalid_grant');
  });

  test('does not retry a quarantined lineage but still spends a live token', async () => {
    // Arrange — quarantined, yet its access token is still valid
    const vault = makeVault([{ id: 'acc-live', expUtc: NOW + 86_400 }]);
    quarantine(vault, 'acc-live');
    const dead = makeVault([{ id: 'acc-dead', expUtc: NOW - 60 }]);
    quarantine(dead, 'acc-dead');
    const urls: string[] = [];
    const fetchFn = async (url: string | URL | Request): Promise<Response> => {
      urls.push(String(url));
      return usageResponse();
    };

    // Act
    const live = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn,
    });
    const expired = await readVaultCodexQuota({
      vault: dead,
      activeAccountId: null,
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn,
    });

    // Assert — a usable token is read regardless; an expired one is not renewed
    expect(live[0]?.windows[0]?.usedPercent).toBe(42);
    expect(urls).toEqual([USAGE_URL]);
    expect(expired[0]?.windows).toHaveLength(0);
    expect(expired[0]?.warnings.join(' ')).toContain('rejected');
  });

  test('renews and retries when an unexpired token is rejected', async () => {
    // Arrange — `exp` is days away, but codex revoked the token when the
    // user signed in as another account
    const vault = makeVault([{ id: 'acc-1', expUtc: NOW + 86_400 }]);
    const calls: string[] = [];
    let usageAttempts = 0;

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async (url) => {
        calls.push(String(url));
        if (String(url) === TOKEN_URL) {
          return new Response(
            JSON.stringify({ access_token: jwt({ exp: NOW + 86_400 }), refresh_token: 'rt-new' }),
          );
        }
        usageAttempts += 1;
        return usageAttempts === 1
          ? new Response(JSON.stringify({ error: { code: 'token_revoked' } }), { status: 401 })
          : usageResponse();
      },
    });

    // Assert — one renewal, then the reading succeeds
    expect(calls).toEqual([USAGE_URL, TOKEN_URL, USAGE_URL]);
    expect(snapshots[0]?.windows[0]?.usedPercent).toBe(42);
    expect(readCodexTokens(vault.loadCredentials('acc-1') ?? '')?.refreshToken).toBe('rt-new');
  });

  test('a revoked lineage is quarantined so switching to it is blocked', async () => {
    // Arrange — the token is rejected and the grant is dead too
    const vault = makeVault([{ id: 'acc-1', expUtc: NOW + 86_400 }]);

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async (url) =>
        String(url) === TOKEN_URL
          ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
          : new Response(JSON.stringify({ error: { code: 'token_revoked' } }), { status: 401 }),
    });

    // Assert — quarantined, and the message names the fix
    expect(vault.get('acc-1')?.refreshDeadAtUtc).toBe(NOW);
    expect(snapshots[0]?.warnings.join(' ')).toContain('codex login');
  });

  test('a rejected token is reported as-is when renewal is not allowed', async () => {
    // Arrange
    const vault = makeVault([{ id: 'acc-1', expUtc: NOW + 86_400 }]);
    const urls: string[] = [];

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      allowRefresh: false,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ error: { code: 'token_revoked' } }), { status: 401 });
      },
    });

    // Assert — the rejection reaches the user; no token endpoint call
    expect(urls).toEqual([USAGE_URL]);
    expect(snapshots[0]?.failure?.kind).toBe('auth_invalid');
    expect(snapshots[0]?.warnings.join(' ')).toContain('revoked');
  });

  test('allowRefresh false never calls the token endpoint', async () => {
    // Arrange
    const vault = makeVault([{ id: 'acc-1', expUtc: NOW - 60 }]);
    const urls: string[] = [];

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      allowRefresh: false,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async (url) => {
        urls.push(String(url));
        return usageResponse();
      },
    });

    // Assert
    expect(urls).toEqual([]);
    expect(snapshots[0]?.failure?.kind).toBe('unavailable');
  });

  test('only restricts the read to a single stored account', async () => {
    // Arrange
    const vault = makeVault([
      { id: 'acc-1', expUtc: NOW + 86_400 },
      { id: 'acc-2', expUtc: NOW + 86_400 },
    ]);

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      only: 'acc-2',
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async () => usageResponse(),
    });

    // Assert
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.accountId).toBe('acc-2');
  });

  test('ignores vault entries that belong to other agents', async () => {
    // Arrange
    const vault = makeVault([{ id: 'acc-1', expUtc: NOW + 86_400 }]);
    vault.put(
      {
        agent: 'claude-code',
        accountId: 'uuid-claude',
        email: 'claude@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 0 } }),
    );

    // Act
    const snapshots = await readVaultCodexQuota({
      vault,
      activeAccountId: null,
      nowUtc: NOW,
      usageUrl: USAGE_URL,
      tokenUrl: TOKEN_URL,
      fetchFn: async () => usageResponse(),
    });

    // Assert
    expect(snapshots.map((snapshot) => snapshot.accountId)).toEqual(['acc-1']);
  });
});
