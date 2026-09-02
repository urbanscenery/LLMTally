import { beforeEach, describe, expect, test } from 'bun:test';

import {
  cursorCliPlanName,
  cursorCliWindows,
  fetchCursorCliQuota,
  isCursorCliTokenExpired,
  resetCursorCliQuotaState,
} from '@llmtally/core/quota/cursor-cli.ts';
import type { CursorCliCredentials, CursorCliIdentity } from '@llmtally/core/accounts/cursor-cli.ts';
import { normalizeQuotaWindow } from '@llmtally/core/quota/window-policy.ts';

const NOW = 1_786_600_000;
const TOKEN = 'cursor-session-token-xyz';

const identity: CursorCliIdentity = {
  accountId: '405',
  email: 'dev@example.com',
  displayName: 'Dev',
  authId: 'auth-1',
};

function credentials(overrides: Partial<CursorCliCredentials> = {}): CursorCliCredentials {
  return {
    accessToken: TOKEN,
    refreshToken: 'refresh-secret',
    apiKey: null,
    expiresAtUtc: NOW + 3600,
    ...overrides,
  };
}

function usageBody(overrides: Record<string, unknown> = {}) {
  return {
    planUsage: {
      autoPercentUsed: 41,
      apiPercentUsed: 12,
      totalPercentUsed: 53,
      billingCycleEnd: NOW + 86_400,
      spendLimitUsage: { used: 250, limit: 1000 },
      ...overrides,
    },
  };
}

function responder(handler: (url: string) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const calls: string[] = [];
  const fetchFn = (url: string): Promise<Response> => {
    calls.push(url);
    const reply = handler(url);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers }),
    );
  };
  return { fetchFn, calls };
}

describe('cursorCliWindows', () => {
  test('maps auto/api percents and omits totalPercentUsed', () => {
    const windows = cursorCliWindows(usageBody());
    expect(windows.map((window) => window.id)).toEqual([
      'cursor_models',
      'other_models',
      'extra usage $3/$10',
    ]);
    expect(windows.some((window) => window.id.includes('total'))).toBe(false);
    expect(normalizeQuotaWindow('cursor_models')).toEqual({
      label: '1month_CursorModels',
      rank: 2,
      model: 'CursorModels',
    });
    expect(normalizeQuotaWindow('other_models')).toEqual({
      label: '1month_OtherModels',
      rank: 2,
      model: 'OtherModels',
    });
  });

  test('omits a window when the percent is missing', () => {
    const windows = cursorCliWindows(usageBody({ autoPercentUsed: undefined, apiPercentUsed: 8 }));
    expect(windows.map((window) => window.id)).toEqual(['other_models', 'extra usage $3/$10']);
  });

  test('0% is a valid observation', () => {
    const windows = cursorCliWindows(usageBody({ autoPercentUsed: 0, apiPercentUsed: 0, spendLimitUsage: null }));
    expect(windows).toEqual([
      { id: 'cursor_models', usedPercent: 0, resetsAtUtc: NOW + 86_400 },
      { id: 'other_models', usedPercent: 0, resetsAtUtc: NOW + 86_400 },
    ]);
  });
});

describe('fetchCursorCliQuota', () => {
  beforeEach(() => {
    resetCursorCliQuotaState();
  });

  test('200 yields windows and a plan name', async () => {
    const { fetchFn, calls } = responder((url) => {
      if (url.endsWith('GetPlanInfo')) {
        return { status: 200, body: { planInfo: { planName: 'Pro' } } };
      }
      if (url.endsWith('GetCurrentPeriodUsage')) {
        return { status: 200, body: usageBody() };
      }
      return { status: 200, body: { hardLimit: { enabled: true, limit: 1000 } } };
    });

    const snapshot = await fetchCursorCliQuota({
      credentials: credentials(),
      identity,
      nowUtc: NOW,
      fetchFn,
    });

    expect(snapshot.failure).toBeNull();
    expect(snapshot.plan).toBe('Pro');
    expect(snapshot.windows.map((window) => window.id)).toContain('cursor_models');
    expect(snapshot.accountId).toBe('405');
    expect(calls.some((url) => url.includes('GetCurrentPeriodUsage'))).toBe(true);
  });

  test('200 with no windows is still success', async () => {
    const { fetchFn } = responder(() => ({ status: 200, body: {} }));
    const snapshot = await fetchCursorCliQuota({
      credentials: credentials(),
      identity,
      nowUtc: NOW,
      fetchFn,
    });
    expect(snapshot.failure).toBeNull();
    expect(snapshot.windows).toEqual([]);
  });

  test('401 is auth_invalid', async () => {
    const { fetchFn } = responder(() => ({ status: 401, body: {} }));
    const snapshot = await fetchCursorCliQuota({
      credentials: credentials(),
      identity,
      nowUtc: NOW,
      fetchFn,
    });
    expect(snapshot.failure?.kind).toBe('auth_invalid');
    expect(snapshot.warnings.join(' ')).toContain('cursor agent login');
    expect(snapshot.warnings.join(' ')).not.toContain(TOKEN);
  });

  test('429 is rate_limited', async () => {
    const { fetchFn } = responder(() => ({
      status: 429,
      body: {},
      headers: { 'retry-after': '30' },
    }));
    const snapshot = await fetchCursorCliQuota({
      credentials: credentials(),
      identity,
      nowUtc: NOW,
      fetchFn,
    });
    expect(snapshot.failure?.kind).toBe('rate_limited');
    expect(snapshot.retryAfterSeconds).toBe(30);
  });

  test('404 is unavailable and subsequent calls stay gone', async () => {
    const { fetchFn } = responder(() => ({ status: 404, body: {} }));
    const first = await fetchCursorCliQuota({
      credentials: credentials(),
      identity,
      nowUtc: NOW,
      fetchFn,
    });
    expect(first.failure?.kind).toBe('unavailable');
    const second = await fetchCursorCliQuota({
      credentials: credentials(),
      identity,
      nowUtc: NOW + 10,
      fetchFn: () => {
        throw new Error('should not be called while gone');
      },
    });
    expect(second.failure?.kind).toBe('unavailable');
  });

  test('an expired token is unavailable without a network call', async () => {
    expect(isCursorCliTokenExpired(credentials({ expiresAtUtc: NOW - 1 }), NOW)).toBe(true);
    const snapshot = await fetchCursorCliQuota({
      credentials: credentials({ expiresAtUtc: NOW - 1 }),
      identity,
      nowUtc: NOW,
      fetchFn: () => {
        throw new Error('expired tokens must not be sent');
      },
    });
    expect(snapshot.failure?.kind).toBe('unavailable');
  });
});

describe('cursorCliPlanName', () => {
  test('reads planInfo.planName', () => {
    expect(cursorCliPlanName({ planInfo: { planName: 'Pro' } })).toBe('Pro');
    expect(cursorCliPlanName(null)).toBeNull();
  });
});
