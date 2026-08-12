import { beforeEach, describe, expect, test } from 'bun:test';

import {
  fetchOpencodeGoQuota,
  opencodeGoQuotaSubject,
  resetOpencodeEndpointState,
} from '@llmtally/core/quota/opencode.ts';
import { LLMTALLY_USER_AGENT } from '@llmtally/core/version.ts';

const NOW = 1_786_400_000;
const KEY = 'oc-go-secret-key-value';
const ACCOUNT = { accountId: 'cline-pass.opencode-go.3f2a9c', account: 'cline-pass.opencode-go.3f2a9c' };

/** The shape the live endpoint returns (verified 2026-08-12). */
function usageBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    usage: {
      rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-12T18:58:36.693Z' },
      weekly: { status: 'ok', percent: 12, resetsAt: '2026-08-17T00:00:00.693Z' },
      monthly: { status: 'ok', percent: 43, resetsAt: '2026-08-29T03:12:24.693Z' },
      ...overrides,
    },
  };
}

function respond(body: unknown, init: ResponseInit = {}): () => Promise<Response> {
  return () => Promise.resolve(new Response(JSON.stringify(body), init));
}

function fetchGo(fetchFn: Parameters<typeof fetchOpencodeGoQuota>[0]['fetchFn']) {
  return fetchOpencodeGoQuota({ apiKey: KEY, ...ACCOUNT, nowUtc: NOW, fetchFn });
}

beforeEach(() => {
  resetOpencodeEndpointState();
});

describe('fetchOpencodeGoQuota', () => {
  test('parses the three provider windows and binds them to the bundle', async () => {
    // Arrange
    let seenUrl = '';
    let seenInit: RequestInit | undefined;

    // Act
    const snapshot = await fetchGo((url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(new Response(JSON.stringify(usageBody())));
    });

    // Assert
    expect(seenUrl).toBe('https://opencode.ai/zen/go/v1/usage');
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['User-Agent']).toBe(LLMTALLY_USER_AGENT);
    expect(seenInit?.redirect).toBe('error');
    expect(snapshot.agent).toBe('opencode');
    expect(snapshot.accountId).toBe(ACCOUNT.accountId);
    expect(snapshot.plan).toBe('Go');
    expect(snapshot.failure).toBeNull();
    expect(snapshot.windows).toEqual([
      { id: 'rolling', usedPercent: 0, resetsAtUtc: 1_786_561_116 },
      { id: 'weekly', usedPercent: 12, resetsAtUtc: 1_786_924_800 },
      { id: 'monthly', usedPercent: 43, resetsAtUtc: 1_787_973_144 },
    ]);
  });

  test('keeps a zero reading and a reading above 100 exactly as reported', async () => {
    // Arrange
    const body = usageBody({
      rolling: { status: 'ok', percent: 0, resetsAt: null },
      monthly: { status: 'ok', percent: 130, resetsAt: null },
    });

    // Act
    const snapshot = await fetchGo(respond(body));

    // Assert
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([0, 12, 130]);
  });

  test('ignores unknown fields and keeps the windows it understands', async () => {
    // Arrange
    const body = {
      useBalance: true,
      usage: {
        rolling: { status: 'ok', percent: 5, resetsAt: null, somethingNew: 1 },
        quarterly: { status: 'ok', percent: 9 },
      },
      extra: { nested: true },
    };

    // Act
    const snapshot = await fetchGo(respond(body));

    // Assert
    expect(snapshot.failure).toBeNull();
    expect(snapshot.windows).toEqual([{ id: 'rolling', usedPercent: 5, resetsAtUtc: null }]);
    expect(snapshot.warnings).toEqual(['opencode go reported 1 of 3 usage windows']);
  });

  test('drops a window with a non-numeric percent rather than calling it zero', async () => {
    // Arrange
    const body = usageBody({ weekly: { status: 'ok', percent: null, resetsAt: null } });

    // Act
    const snapshot = await fetchGo(respond(body));

    // Assert
    expect(snapshot.windows.map((window) => window.id)).toEqual(['rolling', 'monthly']);
    expect(snapshot.windows.some((window) => window.usedPercent === 0 && window.id === 'weekly')).toBe(
      false,
    );
  });

  test('keeps a window whose resets_at is unparseable, without a reset', async () => {
    // Arrange
    const body = usageBody({ weekly: { status: 'ok', percent: 12, resetsAt: 'not-a-date' } });

    // Act
    const snapshot = await fetchGo(respond(body));

    // Assert
    expect(snapshot.windows[1]).toEqual({ id: 'weekly', usedPercent: 12, resetsAtUtc: null });
  });

  test('an exhausted meter is a warning on a successful reading, not a fetch failure', async () => {
    // Arrange
    const body = usageBody({
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-08-29T03:12:24.693Z' },
    });

    // Act
    const snapshot = await fetchGo(respond(body));

    // Assert — our own 429 is a failure; the vendor's exhaustion is data
    expect(snapshot.failure).toBeNull();
    expect(snapshot.rateLimited).toBe(false);
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.warnings).toContain(
      'opencode go: the monthly window is used up (provider-reported)',
    );
  });

  test.each([
    ['Missing API key.', 'Missing API key.'],
    ['Unauthorized', 'Unauthorized'],
  ])('401 %p invalidates the credential rather than the transport', async (message, expected) => {
    // Arrange
    const body = { type: 'error', error: { type: 'AuthError', message } };

    // Act
    const snapshot = await fetchGo(respond(body, { status: 401 }));

    // Assert
    expect(snapshot.failure?.kind).toBe('auth_invalid');
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.warnings[0]).toContain(expected);
  });

  test('403 reports a missing subscription, not a broken key', async () => {
    // Act
    const snapshot = await fetchGo(
      respond({ error: { message: 'OpenCode Go subscription required.' } }, { status: 403 }),
    );

    // Assert
    expect(snapshot.failure?.kind).toBe('auth_invalid');
    expect(snapshot.warnings[0]).toContain('no active Go subscription');
  });

  test('429 becomes a rate limit carrying the vendor retry hint', async () => {
    // Act
    const snapshot = await fetchGo(
      () =>
        Promise.resolve(
          new Response('{}', { status: 429, headers: { 'retry-after': '90' } }),
        ),
    );

    // Assert
    expect(snapshot.failure?.kind).toBe('rate_limited');
    expect(snapshot.rateLimited).toBe(true);
    expect(snapshot.retryAfterSeconds).toBe(90);
    expect(snapshot.failure?.retryAtUtc).toBe(NOW + 90);
  });

  test('a 5xx is transport, so the last good numbers may still stand', async () => {
    // Act
    const snapshot = await fetchGo(respond({}, { status: 503 }));

    // Assert
    expect(snapshot.failure?.kind).toBe('transport');
  });

  test('a thrown request is transport', async () => {
    // Act
    const snapshot = await fetchGo(() => Promise.reject(new Error('network down')));

    // Assert
    expect(snapshot.failure?.kind).toBe('transport');
    expect(snapshot.warnings[0]).toContain('network down');
  });

  test.each([
    ['malformed json', () => Promise.resolve(new Response('{not json'))],
    ['no usage object', respond({ hello: 'world' })],
    ['no usable windows', respond({ usage: { rolling: { status: 'ok' } } })],
  ])('%s reads as a format change, never as zero usage', async (_label, fetchFn) => {
    // Act
    const snapshot = await fetchGo(fetchFn);

    // Assert
    expect(snapshot.failure?.kind).toBe('transport');
    expect(snapshot.windows).toEqual([]);
  });

  test('a 404 stops this process from calling the dead route again', async () => {
    // Arrange
    let calls = 0;
    const fetchFn = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(new Response('{}', { status: 404 }));
    };

    // Act
    const first = await fetchGo(fetchFn);
    const second = await fetchGo(fetchFn);

    // Assert
    expect(calls).toBe(1);
    expect(first.failure?.kind).toBe('unavailable');
    expect(second.failure?.kind).toBe('unavailable');
    expect(second.warnings[0]).toContain('stopped polling until restart');
  });

  test('one key hitting a dead route does not silence another key', async () => {
    // Arrange — a 404 answered for key A says nothing about key B
    const calls: string[] = [];
    const fetchFn = (_url: string, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers as Record<string, string>;
      const isA = headers.Authorization === `Bearer ${KEY}`;
      calls.push(isA ? 'A' : 'B');
      return Promise.resolve(
        isA
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify(usageBody())),
      );
    };

    // Act
    const first = await fetchGo(fetchFn);
    const second = await fetchOpencodeGoQuota({
      apiKey: 'other-key',
      ...ACCOUNT,
      nowUtc: NOW,
      fetchFn,
    });

    // Assert
    expect(first.failure?.kind).toBe('unavailable');
    expect(second.failure).toBeNull();
    expect(second.windows).toHaveLength(3);
    expect(calls).toEqual(['A', 'B']);
  });

  test('honours a Retry-After given as a date, not just as seconds', async () => {
    // Arrange
    const at = new Date((NOW + 900) * 1000).toUTCString();

    // Act
    const snapshot = await fetchGo(() =>
      Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': at } })),
    );

    // Assert — ignoring the date form would silently shorten the wait
    expect(snapshot.failure?.kind).toBe('rate_limited');
    expect(snapshot.retryAfterSeconds).toBe(900);
  });

  test('the api key never reaches a snapshot, a warning, or an error message', async () => {
    // Arrange
    const responses = [
      respond(usageBody()),
      respond({ error: { message: KEY } }, { status: 401 }),
      respond({}, { status: 500 }),
      () => Promise.reject(new Error(`connect failed for ${KEY}`)),
    ];

    // Act
    const snapshots = await Promise.all(responses.map((fetchFn) => fetchGo(fetchFn)));

    // Assert — including the paths where the vendor or the runtime
    // echoes the key back at us
    for (const snapshot of snapshots) {
      expect(JSON.stringify(snapshot)).not.toContain(KEY);
    }
  });
});

describe('opencodeGoQuotaSubject', () => {
  test('identifies the budget by the key, not by the bundle holding it', () => {
    // Act
    const first = opencodeGoQuotaSubject({ apiKey: KEY, accountId: 'bundle-a', account: 'a' });
    const second = opencodeGoQuotaSubject({ apiKey: KEY, accountId: 'bundle-b', account: 'b' });
    const rotated = opencodeGoQuotaSubject({ apiKey: 'other-key', accountId: 'bundle-a', account: 'a' });

    // Assert
    expect(first.key).toBe(second.key);
    expect(rotated.key).not.toBe(first.key);
    expect(first.agent).toBe('opencode');
  });

  test('never puts the raw key in the budget identity', () => {
    // Act
    const subject = opencodeGoQuotaSubject({ apiKey: KEY, accountId: null, account: null });

    // Assert
    expect(subject.key).not.toContain(KEY);
    expect(subject.key).toContain('sha256:');
  });
});
