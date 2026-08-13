import { beforeEach, describe, expect, test } from 'bun:test';

import {
  clinePassQuotaSubject,
  fetchClinePassQuota,
  lookupClinePassEmail,
  resetClineQuotaState,
} from '@llmtally/core/quota/cline.ts';
import { LLMTALLY_USER_AGENT } from '@llmtally/core/version.ts';

const NOW = 1_786_400_000;
const KEY = 'cline-pass-secret-key-value';

const IDENTITY = {
  data: { id: 'usr-01KYVB87ZSNXW6DRP1WMVT40EA', email: 'me@test.dev' },
  success: true,
};
const PLAN = { data: { plan: { displayName: 'Cline Pass (Monthly)' } }, success: true };
/** The live shape: five_hour ships without a reset (verified 2026-08-12). */
const LIMITS = {
  data: {
    limits: [
      { type: 'five_hour', percentUsed: 0 },
      { type: 'weekly', percentUsed: 4, resetsAt: '2026-08-14T02:41:06.336524199Z' },
      { type: 'monthly', percentUsed: 2, resetsAt: '2026-09-06T02:41:06.338776948Z' },
    ],
  },
  success: true,
};

/** Routes each url to a body, so a case only states what it changes. */
function router(
  overrides: Record<string, () => Response> = {},
): { fetchFn: (url: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  const defaults: Record<string, () => Response> = {
    '/users/me': () => new Response(JSON.stringify(IDENTITY)),
    '/users/me/plan': () => new Response(JSON.stringify(PLAN)),
    '/users/me/plan/usage-limits': () => new Response(JSON.stringify(LIMITS)),
  };
  return {
    calls,
    fetchFn: (url: string) => {
      const path = url.replace('https://api.cline.bot/api/v1', '');
      calls.push(path);
      const handler = overrides[path] ?? defaults[path];
      if (handler === undefined) {
        throw new Error(`unexpected url ${url}`);
      }
      return Promise.resolve(handler());
    },
  };
}

beforeEach(() => {
  resetClineQuotaState();
});

describe('lookupClinePassEmail', () => {
  test('returns the /users/me email and nothing when identity is unreadable', async () => {
    // Arrange
    const ok = router();
    const dead = router({ '/users/me': () => new Response('{}', { status: 401 }) });

    // Act & Assert
    expect(await lookupClinePassEmail({ apiKey: KEY, nowUtc: NOW, fetchFn: ok.fetchFn })).toBe(
      'me@test.dev',
    );
    resetClineQuotaState();
    expect(await lookupClinePassEmail({ apiKey: KEY, nowUtc: NOW, fetchFn: dead.fetchFn })).toBeNull();
  });
});

describe('fetchClinePassQuota', () => {
  test('names the row from the vendor subject and reads all three windows', async () => {
    // Arrange
    const { fetchFn, calls } = router();

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.agent).toBe('cline');
    expect(snapshot.accountId).toBe('usr-01KYVB87ZSNXW6DRP1WMVT40EA');
    expect(snapshot.account).toBe('me@test.dev');
    expect(snapshot.plan).toBe('Cline Pass (Monthly)');
    expect(snapshot.failure).toBeNull();
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.windows).toEqual([
      { id: 'five_hour', usedPercent: 0, resetsAtUtc: null },
      { id: 'weekly', usedPercent: 4, resetsAtUtc: 1_786_675_266 },
      { id: 'monthly', usedPercent: 2, resetsAtUtc: 1_788_662_466 },
    ]);
    expect(calls).toContain('/users/me/plan/usage-limits');
  });

  test('sends the key as a bearer header on an allowlisted GET', async () => {
    // Arrange
    const seen: RequestInit[] = [];
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push(init ?? {});
      expect(url.startsWith('https://api.cline.bot/api/v1/')).toBe(true);
      const path = url.replace('https://api.cline.bot/api/v1', '');
      const body = path === '/users/me' ? IDENTITY : path === '/users/me/plan' ? PLAN : LIMITS;
      return Promise.resolve(new Response(JSON.stringify(body)));
    };

    // Act
    await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    for (const init of seen) {
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(headers['User-Agent']).toBe(LLMTALLY_USER_AGENT);
      expect(init.redirect).toBe('error');
    }
  });

  test('remembers identity, so a later reading costs one request instead of three', async () => {
    // Arrange
    const { fetchFn, calls } = router();

    // Act
    await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });
    const before = calls.length;
    const second = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW + 600, fetchFn });

    // Assert
    expect(before).toBe(3);
    expect(calls.slice(before)).toEqual(['/users/me/plan/usage-limits']);
    expect(second.accountId).toBe('usr-01KYVB87ZSNXW6DRP1WMVT40EA');
  });

  test('re-reads identity once it is older than its shelf life', async () => {
    // Arrange
    const { fetchFn, calls } = router();

    // Act
    await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });
    await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW + 7 * 3600, fetchFn });

    // Assert
    expect(calls.filter((path) => path === '/users/me')).toHaveLength(2);
  });

  test('a different key never reuses another key identity', async () => {
    // Arrange
    const other = {
      data: { id: 'usr-OTHER', email: 'other@test.dev' },
      success: true,
    };
    let identityCalls = 0;
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      const path = url.replace('https://api.cline.bot/api/v1', '');
      const headers = init?.headers as Record<string, string>;
      if (path === '/users/me') {
        identityCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify(headers.Authorization === `Bearer ${KEY}` ? IDENTITY : other)),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(path === '/users/me/plan' ? PLAN : LIMITS)));
    };

    // Act
    const first = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });
    const second = await fetchClinePassQuota({ apiKey: 'another-key', nowUtc: NOW, fetchFn });

    // Assert
    expect(identityCalls).toBe(2);
    expect(first.accountId).toBe('usr-01KYVB87ZSNXW6DRP1WMVT40EA');
    expect(second.accountId).toBe('usr-OTHER');
  });

  test('keeps the reading when only the plan label is unavailable', async () => {
    // Arrange
    const { fetchFn } = router({ '/users/me/plan': () => new Response('{}', { status: 500 }) });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert — a missing caption must not cost the numbers
    expect(snapshot.failure).toBeNull();
    expect(snapshot.plan).toBeNull();
    expect(snapshot.windows).toHaveLength(3);
  });

  test('refuses to place a reading it cannot attribute to an account', async () => {
    // Arrange
    const { fetchFn, calls } = router({
      '/users/me': () => new Response('{}', { status: 500 }),
    });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure?.kind).toBe('transport');
    expect(snapshot.accountId).toBeNull();
    expect(calls).not.toContain('/users/me/plan/usage-limits');
  });

  test('a rejected key invalidates the credential, keeping the identity it had', async () => {
    // Arrange — identity already known, then the usage call is refused
    const { fetchFn } = router();
    await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });
    const refused = router({
      '/users/me/plan/usage-limits': () => new Response('{}', { status: 401 }),
    });

    // Act
    const snapshot = await fetchClinePassQuota({
      apiKey: KEY,
      nowUtc: NOW + 600,
      fetchFn: refused.fetchFn,
    });

    // Assert
    expect(snapshot.failure?.kind).toBe('auth_invalid');
    expect(snapshot.accountId).toBe('usr-01KYVB87ZSNXW6DRP1WMVT40EA');
    expect(snapshot.windows).toEqual([]);
  });

  test('403 on the usage route is a permission failure, not a broken key', async () => {
    // Arrange
    const { fetchFn } = router({
      '/users/me/plan/usage-limits': () => new Response('{}', { status: 403 }),
    });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure?.kind).toBe('auth_invalid');
    expect(snapshot.warnings[0]).toContain('not allowed to read subscription usage');
  });

  test('429 carries the vendor retry hint', async () => {
    // Arrange
    const { fetchFn } = router({
      '/users/me/plan/usage-limits': () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '45' } }),
    });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure?.kind).toBe('rate_limited');
    expect(snapshot.retryAfterSeconds).toBe(45);
  });

  test('the undocumented route disappearing stops this process from calling it again', async () => {
    // Arrange
    const { fetchFn, calls } = router({
      '/users/me/plan/usage-limits': () => new Response('{}', { status: 404 }),
    });

    // Act
    const first = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });
    const second = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW + 600, fetchFn });

    // Assert
    expect(first.failure?.kind).toBe('unavailable');
    expect(second.failure?.kind).toBe('unavailable');
    expect(calls.filter((path) => path === '/users/me/plan/usage-limits')).toHaveLength(1);
    expect(second.warnings[0]).toContain('stopped polling until restart');
  });

  test('a window without a usable percent is dropped, never read as zero', async () => {
    // Arrange
    const { fetchFn } = router({
      '/users/me/plan/usage-limits': () =>
        new Response(
          JSON.stringify({
            data: {
              limits: [
                { type: 'five_hour', percentUsed: null },
                { type: 'weekly', percentUsed: 4 },
                { type: 'unknown_window', percentUsed: 90 },
              ],
            },
          }),
        ),
    });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.windows).toEqual([{ id: 'weekly', usedPercent: 4, resetsAtUtc: null }]);
    expect(snapshot.warnings).toEqual(['cline reported 1 of 3 usage windows']);
  });

  test.each([
    ['malformed json', () => new Response('{oops')],
    ['no limits array', () => new Response(JSON.stringify({ data: {} }))],
    ['no usable windows', () => new Response(JSON.stringify({ data: { limits: [] } }))],
  ])('%s reads as a format change, never as zero usage', async (_label, handler) => {
    // Arrange
    const { fetchFn } = router({ '/users/me/plan/usage-limits': handler });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure?.kind).toBe('transport');
    expect(snapshot.windows).toEqual([]);
  });

  test('one key hitting a dead route does not hide every other account', async () => {
    // Arrange — key A's usage route is gone; key B's account is fine
    const other = { data: { id: 'usr-OTHER', email: 'other@test.dev' }, success: true };
    const calls: string[] = [];
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      const path = url.replace('https://api.cline.bot/api/v1', '');
      const headers = init?.headers as Record<string, string>;
      const isA = headers.Authorization === `Bearer ${KEY}`;
      calls.push(`${isA ? 'A' : 'B'}${path}`);
      if (path === '/users/me') {
        return Promise.resolve(new Response(JSON.stringify(isA ? IDENTITY : other)));
      }
      if (path === '/users/me/plan') {
        return Promise.resolve(new Response(JSON.stringify(PLAN)));
      }
      return isA
        ? Promise.resolve(new Response('{}', { status: 404 }))
        : Promise.resolve(new Response(JSON.stringify(LIMITS)));
    };

    // Act
    const first = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });
    const second = await fetchClinePassQuota({ apiKey: 'key-b', nowUtc: NOW, fetchFn });

    // Assert — the disable belongs to the credential, not to the route
    expect(first.failure?.kind).toBe('unavailable');
    expect(second.failure).toBeNull();
    expect(second.windows).toHaveLength(3);
    expect(calls).toContain('B/users/me/plan/usage-limits');
  });

  test('a success body echoing the key is refused, not stored as an account', async () => {
    // Arrange — the failure redaction never sees a 200, so the
    // identity fields need their own guard
    const { fetchFn } = router({
      '/users/me': () =>
        new Response(JSON.stringify({ data: { id: KEY, email: KEY }, success: true })),
    });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert — an id that carries the credential invalidates the reading
    expect(snapshot.failure?.kind).toBe('transport');
    expect(snapshot.accountId).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain(KEY);
  });

  test('a tainted caption is dropped without costing the reading', async () => {
    // Arrange — only the droppable fields carry the key
    const { fetchFn } = router({
      '/users/me': () =>
        new Response(
          JSON.stringify({ data: { id: 'usr-01KYVB87ZSNXW6DRP1WMVT40EA', email: KEY } }),
        ),
      '/users/me/plan': () =>
        new Response(JSON.stringify({ data: { plan: { displayName: KEY } } })),
    });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure).toBeNull();
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.account).toBeNull();
    expect(snapshot.plan).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain(KEY);
  });

  test('a failure before identity is named by where the key came from', async () => {
    // Arrange — a stored bundle whose key no longer works
    const { fetchFn } = router({ '/users/me': () => new Response('{}', { status: 401 }) });

    // Act
    const snapshot = await fetchClinePassQuota({
      apiKey: KEY,
      nowUtc: NOW,
      credentialLabel: 'cline-pass.opencode-go.3f2a9c [work]',
      fetchFn,
    });

    // Assert — provenance, not a forged Cline account
    expect(snapshot.failure?.kind).toBe('auth_invalid');
    expect(snapshot.accountId).toBeNull();
    expect(snapshot.account).toBe('cline-pass.opencode-go.3f2a9c [work]');
  });

  test('a refused key drops the identity it had memoized', async () => {
    // Arrange — identity is memoized, then the key stops being accepted.
    // Revocation surfaces on the usage call, because a memo hit means
    // the identity route is not contacted at all.
    const { fetchFn } = router();
    await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });
    const revoked = router({
      '/users/me/plan/usage-limits': () => new Response('{}', { status: 401 }),
    });

    // Act
    const refusal = await fetchClinePassQuota({
      apiKey: KEY,
      nowUtc: NOW + 600,
      fetchFn: revoked.fetchFn,
    });
    await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW + 1200, fetchFn: revoked.fetchFn });

    // Assert — the refusal forces the next cycle to ask who this key is
    // again, instead of naming an account from a stale memory
    expect(refusal.failure?.kind).toBe('auth_invalid');
    expect(revoked.calls.filter((path) => path === '/users/me')).toHaveLength(1);
  });

  test('honours a Retry-After given as a date, not just as seconds', async () => {
    // Arrange
    const at = new Date((NOW + 900) * 1000).toUTCString();
    const { fetchFn } = router({
      '/users/me/plan/usage-limits': () =>
        new Response('{}', { status: 429, headers: { 'retry-after': at } }),
    });

    // Act
    const snapshot = await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn });

    // Assert — ignoring the date form would silently shorten the wait
    expect(snapshot.failure?.kind).toBe('rate_limited');
    expect(snapshot.retryAfterSeconds).toBe(900);
  });

  test('the api key never reaches a snapshot, a warning, or an error message', async () => {
    // Arrange
    const cases = [
      router().fetchFn,
      router({ '/users/me': () => new Response(JSON.stringify({ error: KEY }), { status: 401 }) })
        .fetchFn,
      (): Promise<Response> => Promise.reject(new Error(`connect failed for ${KEY}`)),
    ];

    // Act
    const snapshots = [];
    for (const fetchFn of cases) {
      resetClineQuotaState();
      snapshots.push(await fetchClinePassQuota({ apiKey: KEY, nowUtc: NOW, fetchFn }));
    }

    // Assert
    for (const snapshot of snapshots) {
      expect(JSON.stringify(snapshot)).not.toContain(KEY);
    }
  });
});

describe('clinePassQuotaSubject', () => {
  test('identifies the budget by the key and never carries it in the clear', () => {
    // Act
    const subject = clinePassQuotaSubject({ apiKey: KEY, accountId: null, account: null });
    const rotated = clinePassQuotaSubject({ apiKey: 'other', accountId: null, account: null });

    // Assert
    expect(subject.agent).toBe('cline');
    expect(subject.key).not.toContain(KEY);
    expect(subject.key).toContain('sha256:');
    expect(rotated.key).not.toBe(subject.key);
  });
});
