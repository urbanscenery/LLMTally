import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { readStoredGrokEntry } from '@llmtally/core/accounts/grok.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { GROK_TOKEN_URL, readVaultGrokQuota } from '@llmtally/core/quota/grok-vault.ts';
import type { FetchLike } from '@llmtally/core/quota/providers.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const ENTRY_KEY = 'https://auth.x.ai::client-1';
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

function iso(secondsFromNow: number): string {
  return new Date((NOW + secondsFromNow) * 1000).toISOString();
}

function record(
  userId: string,
  refresh: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: `access-of-${refresh}`,
    auth_mode: 'oidc',
    user_id: userId,
    email: `${userId}@test.dev`,
    refresh_token: refresh,
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'client-1',
    expires_at: iso(3600),
    ...overrides,
  };
}

function makeVault(): AccountVault {
  return new AccountVault({ dir: join(makeTempDir(), 'vault'), keychain: createMemoryKeychain() });
}

function putAccount(
  vault: AccountVault,
  userId: string,
  refresh: string,
  overrides: Record<string, unknown> = {},
): void {
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
    JSON.stringify({ [ENTRY_KEY]: record(userId, refresh, overrides) }),
  );
}

const BILLING_BODY = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: iso(86_400) },
    creditUsagePercent: 42,
  },
};

interface Call {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

/** Routes billing and token-endpoint calls; records everything it saw. */
function makeFetch(handlers: {
  billing?: (call: Call) => Response;
  token?: (call: Call) => Response;
}): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      authorization: headers.get('Authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    if (url === BILLING_URL) {
      return (handlers.billing ?? (() => new Response(JSON.stringify(BILLING_BODY))))(call);
    }
    if (url === GROK_TOKEN_URL) {
      return (handlers.token ?? (() => new Response('unexpected token call', { status: 500 })))(call);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { fetchFn, calls };
}

describe('readVaultGrokQuota', () => {
  test('reads a stored account with its unexpired token and skips live ones', async () => {
    // Arrange — acc-live is in auth.json, acc-vault is not
    const vault = makeVault();
    putAccount(vault, 'acc-live', 'rt-live');
    putAccount(vault, 'acc-vault', 'rt-vault');
    const { fetchFn, calls } = makeFetch({});

    // Act
    const snapshots = await readVaultGrokQuota({
      vault,
      activeAccountIds: ['acc-live'],
      nowUtc: NOW,
      fetchFn,
    });

    // Assert
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.accountId).toBe('acc-vault');
    expect(snapshots[0]?.windows).toEqual([
      { id: 'weekly', usedPercent: 42, resetsAtUtc: NOW + 86_400 },
    ]);
    expect(calls.map((call) => call.url)).toEqual([BILLING_URL]);
    expect(calls[0]?.authorization).toBe('Bearer access-of-rt-vault');
  });

  test('renews an expired token and persists the rotated generation to the vault only', async () => {
    // Arrange
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-old', { expires_at: iso(-10) });
    const { fetchFn, calls } = makeFetch({
      token: () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rt-new', expires_in: 21_600 }),
        ),
    });

    // Act
    const snapshots = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
    });

    // Assert — grant carried client_id, vault holds the rotation, read succeeded
    expect(calls[0]?.url).toBe(GROK_TOKEN_URL);
    expect(calls[0]?.body).toContain('grant_type=refresh_token');
    expect(calls[0]?.body).toContain('client_id=client-1');
    expect(calls[1]?.authorization).toBe('Bearer fresh-access');
    const stored = readStoredGrokEntry(vault.loadCredentials('grok', 'acc-1') ?? '');
    expect(stored?.refreshToken).toBe('rt-new');
    expect(stored?.expiresAtUtc).toBe(NOW + 21_600);
    expect(snapshots[0]?.windows).toHaveLength(1);
  });

  test('quarantines a lineage only on an explicit invalid_grant', async () => {
    // Arrange
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-dead', { expires_at: iso(-10) });
    const { fetchFn } = makeFetch({
      token: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });

    // Act
    const [snapshot] = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
    });

    // Assert
    expect(snapshot?.failure?.kind).toBe('unavailable');
    expect(snapshot?.warnings[0]).toContain('invalid_grant');
    expect(vault.get('grok', 'acc-1')?.refreshDeadAtUtc).toBe(NOW);
  });

  test('a 5xx from the token endpoint stays transient and quarantines nothing', async () => {
    // Arrange
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-1', { expires_at: iso(-10) });
    const { fetchFn } = makeFetch({ token: () => new Response('oops', { status: 503 }) });

    // Act
    const [snapshot] = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
    });

    // Assert
    expect(snapshot?.warnings[0]).toContain('will retry');
    expect(vault.get('grok', 'acc-1')?.refreshDeadAtUtc).toBeNull();
  });

  test('a quarantined expired account never reaches the token endpoint again', async () => {
    // Arrange
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-dead', { expires_at: iso(-10) });
    const { credentialFingerprint } = await import('@llmtally/core/accounts/credentials.ts');
    vault.markRefreshDeadIfFingerprint(
      'grok',
      'acc-1',
      credentialFingerprint(vault.loadCredentials('grok', 'acc-1') ?? ''),
      NOW - 100,
    );
    const { fetchFn, calls } = makeFetch({});

    // Act
    const [snapshot] = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
    });

    // Assert
    expect(calls).toHaveLength(0);
    expect(snapshot?.warnings[0]).toContain('stored refresh token was rejected');
  });

  test('allowRefresh=false keeps the read strictly token-endpoint-free', async () => {
    // Arrange
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-1', { expires_at: iso(-10) });
    const { fetchFn, calls } = makeFetch({});

    // Act
    const [snapshot] = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
      allowRefresh: false,
    });

    // Assert
    expect(calls).toHaveLength(0);
    expect(snapshot?.warnings[0]).toContain('stored token expired');
  });

  test('renews when the endpoint rejects a token expiry still vouched for', async () => {
    // Arrange — expires_at says fine, the vendor says 401 (revoked early)
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-1');
    let billingCalls = 0;
    const { fetchFn } = makeFetch({
      billing: (call) => {
        billingCalls += 1;
        return call.authorization === 'Bearer fresh-access'
          ? new Response(JSON.stringify(BILLING_BODY))
          : new Response('nope', { status: 401 });
      },
      token: () =>
        new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 21_600 })),
    });

    // Act
    const [snapshot] = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
    });

    // Assert
    expect(billingCalls).toBe(2);
    expect(snapshot?.windows).toHaveLength(1);
    // the response carried no rotated refresh token; the lineage is kept
    expect(readStoredGrokEntry(vault.loadCredentials('grok', 'acc-1') ?? '')?.refreshToken).toBe(
      'rt-1',
    );
  });

  test('honours the only filter and ignores other agents', async () => {
    // Arrange
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-1');
    putAccount(vault, 'acc-2', 'rt-2');
    vault.put(
      {
        agent: 'codex',
        accountId: 'acc-1',
        email: null,
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      '{"tokens":{}}',
    );
    const { fetchFn } = makeFetch({});

    // Act
    const snapshots = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
      only: 'acc-2',
    });

    // Assert
    expect(snapshots.map((snapshot) => snapshot.accountId)).toEqual(['acc-2']);
  });

  test('never leaks a token into warnings', async () => {
    // Arrange — transport failure whose message quotes the request
    const vault = makeVault();
    putAccount(vault, 'acc-1', 'rt-1');
    const fetchFn: FetchLike = async () => {
      throw new Error('boom access-of-rt-1 boom');
    };

    // Act
    const [snapshot] = await readVaultGrokQuota({
      vault,
      activeAccountIds: [],
      nowUtc: NOW,
      fetchFn,
    });

    // Assert — quota/grok.ts redacts the credential it was given
    expect(JSON.stringify(snapshot)).not.toContain('access-of-rt-1');
  });
});
