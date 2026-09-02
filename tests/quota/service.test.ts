import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { resetLiveCredentialProbes } from '@llmtally/core/accounts/live-sync.ts';
import type { ActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { dedupeByAccount, loadAllQuota } from '@llmtally/core/quota/service.ts';
import { resetQuotaThrottle } from '@llmtally/core/quota/throttle.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function snapshot(overrides: Partial<QuotaSnapshot> & { agent: string }): QuotaSnapshot {
  return makeQuotaSnapshot({
    source: 'vendor_api',
    observedAtUtc: NOW,
    windows: [{ id: 'five_hour', usedPercent: 10, resetsAtUtc: null }],
    ...overrides,
  });
}

describe('dedupeByAccount', () => {
  test('the freshest reading wins when one account has several sources', () => {
    // Arrange — live now vs a 5h-old third-party cache for the same account
    const live = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'vendor_api',
      observedAtUtc: NOW,
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 18_000,
      warnings: ['cached reading is 5h old (not live)'],
    });

    // Act
    const result = dedupeByAccount([live, cached]);

    // Assert — one row, live kept, the stale row's own staleness note dropped
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('vendor_api');
    expect(result[0]?.warnings).toHaveLength(0);
  });

  test('a cache fresher than our stored sample wins over source rank', () => {
    // Arrange
    const stored = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'stored_history',
      observedAtUtc: NOW - 10_800,
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 60,
    });

    // Act & Assert
    expect(dedupeByAccount([stored, cached])[0]?.source).toBe('third_party_cache');
  });

  test('a failed reading contributes its warning to the surviving row', () => {
    // Arrange — the live call failed (no windows) but explains why
    const failed = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'vendor_api',
      windows: [],
      warnings: ['claude quota fetch failed: http 429'],
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 600,
    });

    // Act
    const result = dedupeByAccount([failed, cached]);

    // Assert — data from the cache, the failure reason preserved
    expect(result).toHaveLength(1);
    expect(result[0]?.windows).toHaveLength(1);
    expect(result[0]?.warnings).toEqual(['claude quota fetch failed: http 429']);
  });

  test('a fresher failed read carries its typed failure onto the merged row', () => {
    // Arrange — the live read was refused just now; the cache has numbers
    const failed = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      windows: [],
      failure: { kind: 'rate_limited', failedAtUtc: NOW, retryAtUtc: NOW + 360 },
      retryAfterSeconds: 360,
      warnings: ['claude usage endpoint returned 429 (rate limited)'],
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 600,
    });

    // Act
    const result = dedupeByAccount([failed, cached]);

    // Assert — numbers from the cache, the CURRENT state stays typed
    expect(result).toHaveLength(1);
    expect(result[0]?.windows).toHaveLength(1);
    expect(result[0]?.failure?.kind).toBe('rate_limited');
    expect(result[0]?.rateLimited).toBe(true);
    expect(result[0]?.retryAfterSeconds).toBe(360);
  });

  test('at the same observation instant, the failure is what gets shown', () => {
    // Arrange — one load produced both rows in the same second
    const failed = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      windows: [],
      failure: { kind: 'deferred', failedAtUtc: NOW, retryAtUtc: NOW + 180 },
    });
    const cached = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
    });

    // Act & Assert — ties break toward surfacing the current failure
    expect(dedupeByAccount([failed, cached])[0]?.failure?.kind).toBe('deferred');
  });

  test('an older failure never overrides a fresher successful read', () => {
    // Arrange
    const staleFailure = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      windows: [],
      observedAtUtc: NOW - 600,
      failure: { kind: 'transport', failedAtUtc: NOW - 600, retryAtUtc: null },
    });
    const freshSuccess = snapshot({ agent: 'claude-code', account: 'me@test.dev' });

    // Act & Assert — the account is healthy now; old failures stay history
    const result = dedupeByAccount([staleFailure, freshSuccess]);
    expect(result[0]?.failure).toBeNull();
  });

  test('the surviving row keeps the position of its first appearance', () => {
    // Arrange
    const codex = snapshot({ agent: 'codex', account: 'c@test.dev' });
    const claudeStale = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev',
      source: 'third_party_cache',
      observedAtUtc: NOW - 3600,
    });
    const claudeLive = snapshot({ agent: 'claude-code', account: 'me@test.dev' });

    // Act
    const result = dedupeByAccount([claudeStale, codex, claudeLive]);

    // Assert
    expect(result.map((entry) => entry.agent)).toEqual(['claude-code', 'codex']);
    expect(result[0]?.source).toBe('vendor_api');
  });

  test('different accounts and unlabeled rows are never merged', () => {
    // Arrange
    const first = snapshot({ agent: 'claude-code', account: 'a@test.dev' });
    const second = snapshot({ agent: 'claude-code', account: 'b@test.dev' });
    const unlabeledA = snapshot({ agent: 'codex', account: null });
    const unlabeledB = snapshot({ agent: 'codex', account: null });

    // Act & Assert
    expect(dedupeByAccount([first, second, unlabeledA, unlabeledB])).toHaveLength(4);
  });

  test('an alias-labeled row stays separate from the plain email row', () => {
    // Arrange — labels differ, so these are treated as distinct rows
    const plain = snapshot({ agent: 'claude-code', account: 'me@test.dev' });
    const aliased = snapshot({
      agent: 'claude-code',
      account: 'me@test.dev [work]',
      source: 'third_party_cache',
    });

    // Act & Assert
    expect(dedupeByAccount([plain, aliased])).toHaveLength(2);
  });
});

// loadAllQuota itself is not unit-tested here: it composes live network
// sources and the machine's real agent stores, so any assertion about it
// would depend on the environment. Its parts are covered individually
// (providers, vault-accounts, antigravity, codex-live) and by the rules above.

describe('loadAllQuota and the opencode credential file', () => {
  const SIGNED_OUT = {
    status: 'signed_out',
    source: 'none',
    activeAccountId: null,
    identity: null,
  } as const;

  function harness(authText: string | null) {
    const home = makeTempDir();
    const authPath = join(home, 'auth.json');
    if (authText !== null) {
      writeFileSync(authPath, authText);
    }
    const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain() });
    return { authPath, vault };
  }

  /** Replaces global fetch so every vendor call this load makes is visible. */
  async function withCountedFetch<T>(run: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = ((url: string): Promise<Response> => {
      urls.push(String(url));
      return Promise.reject(new Error('no vendor call expected'));
    }) as unknown as typeof fetch;
    try {
      return { result: await run(), urls };
    } finally {
      globalThis.fetch = original;
    }
  }

  const SUBSCRIPTION_HOSTS = ['opencode.ai', 'api.cline.bot'];

  test('a credential set without a Go key is not a reason to call the vendor', async () => {
    // Arrange — cline-pass only, which the Go adapter must not touch
    const { authPath, vault } = harness(
      JSON.stringify({ 'cline-pass': { type: 'api', key: 'sk-pass' } }),
    );
    resetQuotaThrottle();

    // Act
    const { result, urls } = await withCountedFetch(() =>
      loadAllQuota({
        agent: 'opencode',
        nowUtc: NOW,
        vault,
        activeContext: SIGNED_OUT,
        opencodeAuthPath: authPath,
      }),
    );

    // Assert
    expect(result).toEqual([]);
    expect(urls).toEqual([]);
  });

  test('no credential file at all yields no rows and no calls', async () => {
    // Arrange
    const { authPath, vault } = harness(null);
    resetQuotaThrottle();

    // Act
    const { result, urls } = await withCountedFetch(() =>
      loadAllQuota({
        agent: 'opencode',
        nowUtc: NOW,
        vault,
        activeContext: SIGNED_OUT,
        opencodeAuthPath: authPath,
      }),
    );

    // Assert
    expect(result).toEqual([]);
    expect(urls).toEqual([]);
  });

  test('asking for another agent never spends the opencode credential', async () => {
    // Arrange — a Go key that would be spent if the filter leaked
    const { authPath, vault } = harness(
      JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-go' } }),
    );
    resetQuotaThrottle();

    // Act
    const { result, urls } = await withCountedFetch(() =>
      loadAllQuota({
        agent: 'antigravity',
        nowUtc: NOW,
        vault,
        activeContext: SIGNED_OUT,
        opencodeAuthPath: authPath,
      }),
    );

    // Assert — whatever antigravity does on its own, the subscription
    // endpoints stay untouched when they were not asked for
    expect(result.every((entry) => entry.agent === 'antigravity')).toBe(true);
    expect(urls.filter((url) => SUBSCRIPTION_HOSTS.some((host) => url.includes(host)))).toEqual([]);
  });
});

describe('loadAllQuota and the grok credential file', () => {
  const SIGNED_OUT = {
    status: 'signed_out',
    source: 'none',
    activeAccountId: null,
    identity: null,
  } as const;

  function harness(): { home: string; vault: AccountVault } {
    const home = makeTempDir();
    const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain() });
    return { home, vault };
  }

  async function grokRows(grokAuthPath: string, vault: AccountVault): Promise<QuotaSnapshot[]> {
    const original = globalThis.fetch;
    globalThis.fetch = ((): Promise<Response> =>
      Promise.reject(new Error('no vendor call expected'))) as unknown as typeof fetch;
    try {
      return await loadAllQuota({
        agent: 'grok',
        nowUtc: NOW,
        vault,
        activeContext: SIGNED_OUT,
        grokAuthPath,
      });
    } finally {
      globalThis.fetch = original;
    }
  }

  test('a machine without the grok CLI gets no grok row', async () => {
    // Arrange — ~/.grok itself does not exist
    const { home, vault } = harness();
    resetQuotaThrottle();

    // Act
    const rows = await grokRows(join(home, '.grok', 'auth.json'), vault);

    // Assert
    expect(rows).toEqual([]);
  });

  test('a signed-out or mid-rewrite credential file keeps a placeholder grok row', async () => {
    // Arrange — the CLI's directory exists but auth.json is missing, then torn
    const { home, vault } = harness();
    const dir = join(home, '.grok');
    mkdirSync(dir);
    const authPath = join(dir, 'auth.json');
    resetQuotaThrottle();

    // Act
    const signedOut = await grokRows(authPath, vault);
    writeFileSync(authPath, '{"https://auth.x.ai::c1": {"key": "abc"');
    const torn = await grokRows(authPath, vault);

    // Assert — the provider stays in the list; the row explains itself
    // and never carries windows or an identity nothing readable named
    expect(signedOut).toHaveLength(1);
    expect(signedOut[0]?.agent).toBe('grok');
    expect(signedOut[0]?.windows).toEqual([]);
    expect(signedOut[0]?.failure?.kind).toBe('unavailable');
    expect(signedOut[0]?.warnings.join(' ')).toContain('not signed in');
    expect(torn).toHaveLength(1);
    expect(torn[0]?.warnings.join(' ')).toContain('could not be read');
  });

  test('vault-stored grok accounts get their own rows next to the live ones', async () => {
    // Arrange — grok is signed out, but the vault holds a second account
    // whose token has expired; read-only mode must still surface the row
    const { home, vault } = harness();
    const dir = join(home, '.grok');
    mkdirSync(dir);
    vault.put(
      {
        agent: 'grok',
        accountId: 'acc-vault',
        email: 'vaulted@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      JSON.stringify({
        'https://auth.x.ai::client-1': {
          key: 'stored-access-token',
          user_id: 'acc-vault',
          email: 'vaulted@test.dev',
          refresh_token: 'stored-refresh-token',
          oidc_client_id: 'client-1',
          expires_at: new Date((NOW - 10) * 1000).toISOString(),
        },
      }),
    );
    resetQuotaThrottle();
    const original = globalThis.fetch;
    globalThis.fetch = ((): Promise<Response> =>
      Promise.reject(new Error('no vendor call expected'))) as unknown as typeof fetch;

    // Act
    let rows: QuotaSnapshot[];
    try {
      rows = await loadAllQuota({
        agent: 'grok',
        nowUtc: NOW,
        vault,
        activeContext: SIGNED_OUT,
        grokAuthPath: join(dir, 'auth.json'),
        allowRefresh: false,
      });
    } finally {
      globalThis.fetch = original;
    }

    // Assert — the signed-out placeholder AND the stored account, which
    // explains that switching (not a token call) is the way back in
    const storedRow = rows.find((row) => row.accountId === 'acc-vault');
    expect(rows).toHaveLength(2);
    expect(storedRow?.account).toBe('vaulted@test.dev');
    expect(storedRow?.failure?.kind).toBe('unavailable');
    expect(storedRow?.warnings.join(' ')).toContain('stored token expired');
    expect(JSON.stringify(rows)).not.toContain('stored-access-token');
  });
});

describe('active claude quota attribution', () => {
  const IDENTIFIED_A = {
    status: 'identified',
    source: 'claude_config',
    activeAccountId: 'uuid-a',
    identity: {
      accountUuid: 'uuid-a',
      email: 'a@test.dev',
      organizationUuid: null,
      organizationName: null,
    },
  } as const;

  function liveStore(text: string): ActiveCredentialStore {
    return {
      backend: 'file',
      read: () => text,
      write: () => undefined,
      clear: () => undefined,
      touch: () => undefined,
    };
  }

  function credentialsOf(refresh: string): string {
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: `access-${refresh}`,
        refreshToken: refresh,
        expiresAt: (NOW + 3600) * 1000,
      },
    });
  }

  function profileAnswering(uuid: string, calls: string[]) {
    return (url: string): Promise<Response> => {
      calls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ account: { uuid, email: `${uuid}@test.dev` } })),
      );
    };
  }

  test('a foreign live credential defers the reading instead of attributing it', async () => {
    // Arrange — config says A, but the oracle says the bytes are B's
    // (/login writes the credential store and ~/.claude.json separately)
    resetLiveCredentialProbes();
    resetQuotaThrottle();
    const vault = new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain() });
    const profileCalls: string[] = [];

    // Act
    const { result, urls } = await (async () => {
      const original = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = ((url: string): Promise<Response> => {
        urls.push(String(url));
        return Promise.reject(new Error('no vendor call expected'));
      }) as unknown as typeof fetch;
      try {
        const result = await loadAllQuota({
          agent: 'claude-code',
          nowUtc: NOW,
          vault,
          activeContext: IDENTIFIED_A,
          activeStore: liveStore(credentialsOf('refresh-b')),
          profileFetchFn: profileAnswering('uuid-b', profileCalls),
        });
        return { result, urls };
      } finally {
        globalThis.fetch = original;
      }
    })();

    // Assert — deferred: attributed row exists but carries no reading,
    // and the usage endpoint was never spent under the wrong account
    expect(profileCalls).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.accountId).toBe('uuid-a');
    expect(result[0]?.windows).toEqual([]);
    expect(result[0]?.failure?.kind).toBe('account_mismatch');
    expect(result[0]?.failure?.credentialOwner?.accountId).toBe('uuid-b');
    expect(result[0]?.warnings[0]).toMatch(/different account.*switch again/);
    expect(urls).toEqual([]);
  });

  test('an owned live credential proceeds to the usage endpoint', async () => {
    // Arrange — the oracle confirms the bytes belong to the named account
    resetLiveCredentialProbes();
    resetQuotaThrottle();
    const vault = new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain() });
    const profileCalls: string[] = [];

    // Act
    const { result, urls } = await (async () => {
      const original = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = ((url: string): Promise<Response> => {
        urls.push(String(url));
        return Promise.resolve(
          new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: null } })),
        );
      }) as unknown as typeof fetch;
      try {
        const result = await loadAllQuota({
          agent: 'claude-code',
          nowUtc: NOW,
          vault,
          activeContext: IDENTIFIED_A,
          activeStore: liveStore(credentialsOf('refresh-a')),
          profileFetchFn: profileAnswering('uuid-a', profileCalls),
        });
        return { result, urls };
      } finally {
        globalThis.fetch = original;
      }
    })();

    // Assert — verification passed and the reading is attributed to A
    expect(profileCalls).toHaveLength(1);
    expect(urls.length).toBeGreaterThan(0);
    expect(result[0]?.accountId).toBe('uuid-a');
    expect(result[0]?.windows[0]?.usedPercent).toBe(42);
  });
});

describe('stored claude budget key', () => {
  test('a stored account claims under its token fingerprint, like the live path', async () => {
    // Arrange — one stored (inactive) account with a usable token; the
    // vendor budgets per token, so the key must follow the token
    resetQuotaThrottle();
    const home = makeTempDir();
    const databasePath = join(home, 'ledger.db');
    const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain() });
    vault.put(
      {
        agent: 'claude-code',
        accountId: 'uuid-stored',
        email: 'stored@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'access-stored',
          refreshToken: 'refresh-stored',
          expiresAt: (NOW + 3600) * 1000,
        },
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: null } })),
      )) as unknown as typeof fetch;

    // Act
    try {
      await loadAllQuota({
        agent: 'claude-code',
        nowUtc: NOW,
        vault,
        databasePath,
        activeContext: {
          status: 'signed_out',
          source: 'none',
          activeAccountId: null,
          identity: null,
        },
      });
    } finally {
      globalThis.fetch = original;
    }

    // Assert — the persisted claim row is keyed by token, not account
    const { Database } = await import('bun:sqlite');
    const db = new Database(databasePath, { readonly: true, strict: true });
    try {
      const rows = db
        .query<{ key: string; account_id: string | null }, []>(
          `SELECT key, account_id FROM quota_fetch_state WHERE agent = 'claude-code'`,
        )
        .all();
      const storedRow = rows.find((row) => row.account_id === 'uuid-stored');
      expect(storedRow?.key).toMatch(/\|token=sha256:/);
      expect(rows.some((row) => row.key.includes('|acct='))).toBe(false);
    } finally {
      db.close();
    }
  });
});
