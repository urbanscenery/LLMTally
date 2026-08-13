import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readAntigravityQuota, resolveActiveAccount } from '@llmtally/core/quota/antigravity.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const NOW_MS = NOW * 1000;

interface StoreOptions {
  readonly activeAccount?: string | null;
  readonly accounts: readonly {
    readonly email: string;
    readonly expiresAtMs?: number;
    readonly projectId?: string | null;
    readonly lastUsed?: string;
    readonly cache?: unknown;
  }[];
}

function writeStore(options: StoreOptions): string {
  const root = makeTempDir();
  mkdirSync(join(root, 'accounts'), { recursive: true });
  if (options.activeAccount !== null) {
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: '2.0', activeAccount: options.activeAccount ?? options.accounts[0]?.email }),
    );
  }
  for (const account of options.accounts) {
    const dir = join(root, 'accounts', account.email);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tokens.json'),
      JSON.stringify({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: account.expiresAtMs ?? NOW_MS - 1000,
        email: account.email,
        projectId: account.projectId === undefined ? 'project-1' : account.projectId,
      }),
    );
    if (account.lastUsed !== undefined) {
      writeFileSync(
        join(dir, 'metadata.json'),
        JSON.stringify({ email: account.email, lastUsed: account.lastUsed }),
      );
    }
    if (account.cache !== undefined) {
      writeFileSync(join(dir, 'cache.json'), JSON.stringify(account.cache));
    }
  }
  return root;
}

function cacheFixture(cachedAt: string): unknown {
  return {
    cachedAt,
    ttl: 300,
    data: {
      timestamp: cachedAt,
      method: 'local',
      email: 'a@test.dev',
      models: [
        {
          label: 'Gemini 3.5 Flash (High)',
          remainingPercentage: 0.95,
          resetTime: '2026-08-11T05:00:00Z',
          isAutocompleteOnly: false,
        },
        {
          label: 'Gemini 3.1 Pro (High)',
          remainingPercentage: 0.25,
          resetTime: '2026-08-11T06:00:00Z',
          isAutocompleteOnly: false,
        },
        {
          label: 'Autocomplete Model',
          remainingPercentage: 0.1,
          isAutocompleteOnly: true,
        },
      ],
      promptCredits: { available: 500, monthly: 50000, usedPercentage: 0.99 },
    },
  };
}

describe('resolveActiveAccount', () => {
  test('config.json activeAccount wins over recency', () => {
    // Arrange
    const root = writeStore({
      activeAccount: 'b@test.dev',
      accounts: [
        { email: 'a@test.dev', lastUsed: '2026-08-10T12:00:00Z' },
        { email: 'b@test.dev', lastUsed: '2026-01-01T00:00:00Z' },
      ],
    });

    // Act & Assert
    expect(resolveActiveAccount(root)?.email).toBe('b@test.dev');
  });

  test('falls back to the most recently used account when config is absent', () => {
    // Arrange
    const root = writeStore({
      activeAccount: null,
      accounts: [
        { email: 'old@test.dev', lastUsed: '2026-01-01T00:00:00Z' },
        { email: 'new@test.dev', lastUsed: '2026-08-10T12:00:00Z' },
      ],
    });

    // Act & Assert
    expect(resolveActiveAccount(root)?.email).toBe('new@test.dev');
  });
});

describe('readAntigravityQuota', () => {
  test('valid token fetches live quota from the daily endpoint', async () => {
    // Arrange
    const root = writeStore({
      accounts: [{ email: 'a@test.dev', expiresAtMs: NOW_MS + 3_600_000 }],
    });
    const calls: string[] = [];
    const fetchFn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      calls.push(target);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-access-token');
      if (target.endsWith(':loadCodeAssist')) {
        return Promise.resolve(
          new Response(JSON.stringify({ cloudaicompanionProject: 'project-live' })),
        );
      }
      expect(JSON.parse(String(init?.body)).project).toBe('project-live');
      // real endpoint shape: models is a map keyed by model id
      return Promise.resolve(
        new Response(
          JSON.stringify({
            defaultAgentModelId: 'gemini-default',
            models: {
              'gemini-other': {
                displayName: 'Gemini Other (Low)',
                quotaInfo: { remainingFraction: 0.9, resetTime: '2026-08-11T05:00:00Z' },
              },
              'gemini-default': {
                displayName: 'Gemini Default (High)',
                quotaInfo: { remainingFraction: 0.6, resetTime: '2026-08-11T06:00:00Z' },
              },
            },
          }),
        ),
      );
    };

    // Act
    const snapshot = await readAntigravityQuota({ storeDir: root, nowUtc: NOW, fetchFn });

    // Assert
    expect(calls).toHaveLength(2);
    expect(snapshot.source).toBe('vendor_api');
    expect(snapshot.account).toBe('a@test.dev');
    // no preferred label present -> defaultAgentModelId wins over map order
    expect(snapshot.windows[0]).toMatchObject({
      id: 'Gemini Default (High)',
      resetsAtUtc: Math.floor(Date.parse('2026-08-11T06:00:00Z') / 1000),
    });
    expect(snapshot.windows[0]?.usedPercent).toBeCloseTo(40, 5);
    expect(snapshot.warnings).toHaveLength(0);
  });

  test('expired token with refresh disabled degrades to the CLI cache without any network call', async () => {
    // Arrange — token expired, fresh cache present
    const cachedAt = new Date((NOW - 120) * 1000).toISOString();
    const root = writeStore({
      accounts: [{ email: 'a@test.dev', cache: cacheFixture(cachedAt) }],
    });
    let fetched = false;

    // Act
    const snapshot = await readAntigravityQuota({
      storeDir: root,
      nowUtc: NOW,
      allowRefresh: false,
      fetchFn: () => {
        fetched = true;
        return Promise.reject(new Error('must not be called'));
      },
    });

    // Assert — preferred model + prompt credits, cached source, expiry guidance
    expect(fetched).toBe(false);
    expect(snapshot.source).toBe('third_party_cache');
    expect(snapshot.observedAtUtc).toBe(NOW - 120);
    expect(snapshot.windows.map((window) => window.id)).toEqual([
      'Gemini 3.1 Pro (High)',
      'prompt credits',
    ]);
    expect(snapshot.windows[0]?.usedPercent).toBeCloseTo(75, 5);
    expect(snapshot.windows[1]?.usedPercent).toBeCloseTo(99, 5);
    expect(snapshot.warnings.some((warning) => warning.includes('refresh disabled'))).toBe(true);
  });

  test('expired token refreshes in memory and fetches live without touching the store', async () => {
    // Arrange
    const root = writeStore({ accounts: [{ email: 'a@test.dev' }] });
    const tokensPath = join(root, 'accounts', 'a@test.dev', 'tokens.json');
    const storedBytes = readFileSync(tokensPath, 'utf8');
    const calls: string[] = [];
    const fetchFn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      calls.push(target);
      if (target.includes('oauth2.googleapis.com')) {
        const body = String(init?.body);
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=test-refresh-token');
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 })),
        );
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer fresh-token');
      if (target.endsWith(':loadCodeAssist')) {
        return Promise.resolve(new Response(JSON.stringify({ cloudaicompanionProject: 'p1' })));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            defaultAgentModelId: 'm1',
            models: {
              m1: {
                displayName: 'Gemini Default (High)',
                quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-11T06:00:00Z' },
              },
            },
          }),
        ),
      );
    };

    // Act
    const snapshot = await readAntigravityQuota({ storeDir: root, nowUtc: NOW, fetchFn });

    // Assert — live via refreshed token; the store file is byte-identical
    expect(calls).toHaveLength(3);
    expect(snapshot.source).toBe('vendor_api');
    expect(snapshot.windows[0]?.usedPercent).toBeCloseTo(20, 5);
    expect(readFileSync(tokensPath, 'utf8')).toBe(storedBytes);
  });

  test('a refreshed token is reused within the process instead of re-refreshing', async () => {
    // Arrange — expired stored token; two readings in a row
    const root = writeStore({ accounts: [{ email: 'cache-reuse@test.dev' }] });
    let refreshCalls = 0;
    const fetchFn = (url: string | URL | Request): Promise<Response> => {
      const target = String(url);
      if (target.includes('oauth2.googleapis.com')) {
        refreshCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 })),
        );
      }
      if (target.endsWith(':loadCodeAssist')) {
        return Promise.resolve(new Response(JSON.stringify({ cloudaicompanionProject: 'p1' })));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            defaultAgentModelId: 'm1',
            models: { m1: { displayName: 'M', quotaInfo: { remainingFraction: 0.5 } } },
          }),
        ),
      );
    };

    // Act — second call happens while the refreshed token is still valid
    await readAntigravityQuota({ storeDir: root, nowUtc: NOW, fetchFn });
    const second = await readAntigravityQuota({ storeDir: root, nowUtc: NOW + 60, fetchFn });

    // Assert
    expect(refreshCalls).toBe(1);
    expect(second.source).toBe('vendor_api');
  });

  test('a rotated refresh token cannot be persisted and produces a warning', async () => {
    // Arrange
    const root = writeStore({ accounts: [{ email: 'a@test.dev' }] });
    const fetchFn = (url: string | URL | Request): Promise<Response> => {
      const target = String(url);
      if (target.includes('oauth2.googleapis.com')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'fresh-token',
              expires_in: 3600,
              refresh_token: 'rotated-token',
            }),
          ),
        );
      }
      if (target.endsWith(':loadCodeAssist')) {
        return Promise.resolve(new Response(JSON.stringify({ cloudaicompanionProject: 'p1' })));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            defaultAgentModelId: 'm1',
            models: {
              m1: { displayName: 'M', quotaInfo: { remainingFraction: 0.5 } },
            },
          }),
        ),
      );
    };

    // Act
    const snapshot = await readAntigravityQuota({ storeDir: root, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.source).toBe('vendor_api');
    expect(snapshot.warnings.some((warning) => warning.includes('rotated'))).toBe(true);
  });

  test('refresh failure falls back to the cache with guidance', async () => {
    // Arrange — expired token, refresh endpoint down, cache present
    const cachedAt = new Date((NOW - 60) * 1000).toISOString();
    const root = writeStore({
      accounts: [{ email: 'a@test.dev', cache: cacheFixture(cachedAt) }],
    });

    // Act
    const snapshot = await readAntigravityQuota({
      storeDir: root,
      nowUtc: NOW,
      fetchFn: (url) =>
        String(url).includes('oauth2.googleapis.com')
          ? Promise.resolve(new Response('denied', { status: 400 }))
          : Promise.reject(new Error('must not reach cloud code')),
    });

    // Assert
    expect(snapshot.source).toBe('third_party_cache');
    expect(snapshot.windows.length).toBeGreaterThan(0);
    expect(snapshot.warnings.some((warning) => warning.includes('token refresh failed'))).toBe(true);
  });

  test('a stale cache is dropped, not served as current', async () => {
    // Arrange — cache is 26 hours old: the antigravity-usage CLI's
    // frozen state, not a reading. Serving it resurrected a 42-day-old
    // "99% used" on every transient timeout.
    const cachedAt = new Date((NOW - 26 * 3600) * 1000).toISOString();
    const root = writeStore({
      accounts: [{ email: 'a@test.dev', cache: cacheFixture(cachedAt) }],
    });

    // Act
    const snapshot = await readAntigravityQuota({ storeDir: root, nowUtc: NOW, allowRefresh: false });

    // Assert — no windows (stored last-good takes over downstream)
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.warnings.some((warning) => warning.includes('26h old'))).toBe(true);
  });

  test('live fetch failure falls back to the cache with a fetch warning', async () => {
    // Arrange — valid token but endpoint down
    const cachedAt = new Date((NOW - 60) * 1000).toISOString();
    const root = writeStore({
      accounts: [
        { email: 'a@test.dev', expiresAtMs: NOW_MS + 3_600_000, cache: cacheFixture(cachedAt) },
      ],
    });

    // Act
    const snapshot = await readAntigravityQuota({
      storeDir: root,
      nowUtc: NOW,
      fetchFn: () => Promise.reject(new Error('offline')),
    });

    // Assert
    expect(snapshot.source).toBe('third_party_cache');
    expect(snapshot.windows.length).toBeGreaterThan(0);
    expect(snapshot.warnings.some((warning) => warning.includes('fetch failed'))).toBe(true);
  });

  test('missing store yields install guidance and no windows', async () => {
    // Act
    const snapshot = await readAntigravityQuota({
      storeDir: join(makeTempDir(), 'none'),
      nowUtc: NOW,
    });

    // Assert
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.warnings[0]).toContain('antigravity-usage login');
  });

  test('expired token with no cache reports both conditions', async () => {
    // Arrange
    const root = writeStore({ accounts: [{ email: 'a@test.dev' }] });

    // Act
    const snapshot = await readAntigravityQuota({ storeDir: root, nowUtc: NOW, allowRefresh: false });

    // Assert
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.warnings.some((warning) => warning.includes('refresh disabled'))).toBe(true);
    expect(snapshot.warnings.some((warning) => warning.includes('no cached'))).toBe(true);
  });
});

describe('per-account reads', () => {
  test('accountEmail reads that account, not the active one', async () => {
    // Arrange — b@ is active, but we ask for a@ (with a valid token)
    const root = writeStore({
      activeAccount: 'b@test.dev',
      accounts: [
        { email: 'a@test.dev', expiresAtMs: NOW_MS + 3_600_000 },
        { email: 'b@test.dev', expiresAtMs: NOW_MS + 3_600_000 },
      ],
    });
    const bodies: string[] = [];

    // Act
    const snapshot = await readAntigravityQuota({
      storeDir: root,
      nowUtc: NOW,
      accountEmail: 'a@test.dev',
      fetchFn: (url) => {
        bodies.push(String(url));
        if (String(url).includes('loadCodeAssist')) {
          return Promise.resolve(new Response(JSON.stringify({ cloudaicompanionProject: 'p1' })));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              defaultAgentModelId: 'gemini-default',
              models: {
                'gemini-default': {
                  displayName: 'Gemini 3.1 Pro (High)',
                  quotaInfo: { remainingFraction: 0.6, resetTime: '2026-08-12T12:00:00Z' },
                },
              },
            }),
          ),
        );
      },
    });

    // Assert — the reading belongs to a@, with the stable id set
    expect(snapshot.account).toBe('a@test.dev');
    expect(snapshot.accountId).toBe('a@test.dev');
    expect(snapshot.windows.length).toBeGreaterThan(0);
  });

  test('an unknown accountEmail degrades to a warning, never another account', async () => {
    // Arrange
    const root = writeStore({
      activeAccount: 'a@test.dev',
      accounts: [{ email: 'a@test.dev', expiresAtMs: NOW_MS + 3_600_000 }],
    });

    // Act
    const snapshot = await readAntigravityQuota({
      storeDir: root,
      nowUtc: NOW,
      accountEmail: 'gone@test.dev',
      fetchFn: () => Promise.reject(new Error('must not be called')),
    });

    // Assert
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.account).toBe('gone@test.dev');
    expect(snapshot.warnings.join(' ')).toContain('not found');
  });
});
