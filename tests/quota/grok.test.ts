import { beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  describeEmptyGrokCredentials,
  fetchGrokQuota,
  grokPeriodWindowId,
  grokPlaceholderSnapshot,
  grokQuotaSubject,
  grokWindows,
  isGrokTokenExpired,
  readGrokCredentials,
  resetGrokQuotaState,
} from '@llmtally/core/quota/grok.ts';
import type { GrokCredential } from '@llmtally/core/quota/grok.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_600_000;
const TOKEN = 'grok-session-token-xyz';

function authFile(entries: Record<string, unknown>): string {
  const path = join(makeTempDir(), 'auth.json');
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    key: TOKEN,
    auth_mode: 'oidc',
    user_id: 'user-uuid-1',
    email: 'dev@example.com',
    team_id: 'team-1',
    refresh_token: 'refresh-secret',
    expires_at: new Date((NOW + 3600) * 1000).toISOString(),
    ...overrides,
  };
}

function credential(overrides: Partial<GrokCredential> = {}): GrokCredential {
  return {
    accountId: 'user-uuid-1',
    account: 'dev@example.com',
    accessToken: TOKEN,
    expiresAtUtc: NOW + 3600,
    ...overrides,
  };
}

function billingBody(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: new Date((NOW - 86_400) * 1000).toISOString(),
        end: new Date((NOW + 500_000) * 1000).toISOString(),
      },
      creditUsagePercent: 37.5,
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      productUsage: [{ product: 'GrokBuild', usagePercent: 37.5 }],
      isUnifiedBillingUser: true,
      ...overrides,
    },
  };
}

function responder(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
    );
  };
  return { fetchFn, calls };
}

describe('readGrokCredentials', () => {
  test('reads every login and never surfaces the refresh token', () => {
    // Arrange
    const path = authFile({
      'https://auth.x.ai::c1': entry(),
      'https://auth.x.ai::c2': entry({ key: 'second-token', user_id: 'user-uuid-2', email: 'two@example.com' }),
    });

    // Act
    const credentials = readGrokCredentials(path);

    // Assert
    expect(credentials.map((c) => c.accountId)).toEqual(['user-uuid-1', 'user-uuid-2']);
    expect(credentials[0]?.expiresAtUtc).toBe(NOW + 3600);
    expect(JSON.stringify(credentials)).not.toContain('refresh-secret');
  });

  test('a missing, torn, or keyless file yields no credentials instead of throwing', () => {
    // Arrange
    const torn = join(makeTempDir(), 'auth.json');
    writeFileSync(torn, '{"https://auth.x.ai::c1": {"key": "abc"');

    // Act & Assert — the CLI rewrites this file under a lock
    expect(readGrokCredentials(join(makeTempDir(), 'absent.json'))).toEqual([]);
    expect(readGrokCredentials(torn)).toEqual([]);
    expect(readGrokCredentials(authFile({ 'https://auth.x.ai::c1': { email: 'x@y.z' } }))).toEqual([]);
  });
});

describe('describeEmptyGrokCredentials', () => {
  test('tells "never installed" apart from "signed out" and "mid-rewrite"', () => {
    // Arrange — four shapes of an empty read
    const missingDir = join(makeTempDir(), 'no-such-dir', 'auth.json');
    const missingFile = join(makeTempDir(), 'auth.json');
    const torn = join(makeTempDir(), 'auth.json');
    writeFileSync(torn, '{"https://auth.x.ai::c1": {"key": "abc"');
    const keyless = authFile({ 'https://auth.x.ai::c1': { email: 'x@y.z' } });

    // Act & Assert
    expect(describeEmptyGrokCredentials(missingDir)).toBe('not_installed');
    expect(describeEmptyGrokCredentials(missingFile)).toBe('signed_out');
    expect(describeEmptyGrokCredentials(torn)).toBe('unreadable');
    expect(describeEmptyGrokCredentials(keyless)).toBe('signed_out');
  });
});

describe('grokPlaceholderSnapshot', () => {
  test('keeps the provider on screen without inventing a reading or an identity', () => {
    // Act
    const snapshot = grokPlaceholderSnapshot(NOW, 'signed_out');

    // Assert — a windowless, unavailable Grok row that names the reason
    expect(snapshot.agent).toBe('grok');
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.accountId).toBeNull();
    expect(snapshot.failure?.kind).toBe('unavailable');
    expect(snapshot.warnings.join(' ')).toContain('run "grok"');
    expect(grokPlaceholderSnapshot(NOW, 'unreadable').warnings.join(' ')).toContain('could not be read');
  });
});

describe('grokPeriodWindowId', () => {
  test('maps known periods to policy names and keeps unknown ones verbatim', () => {
    // Act & Assert
    expect(grokPeriodWindowId('USAGE_PERIOD_TYPE_WEEKLY')).toBe('weekly');
    expect(grokPeriodWindowId('USAGE_PERIOD_TYPE_MONTHLY')).toBe('monthly');
    expect(grokPeriodWindowId('USAGE_PERIOD_TYPE_DAILY')).toBe('daily');
    expect(grokPeriodWindowId(null)).toBe('usage');
  });
});

describe('grokWindows', () => {
  test('emits the shared pool and drops a per-product duplicate of it', () => {
    // Act
    const windows = grokWindows(billingBody());

    // Assert — productUsage repeats the pool figure on a single-product plan
    expect(windows).toEqual([
      { id: 'weekly', usedPercent: 37.5, resetsAtUtc: NOW + 500_000 },
    ]);
  });

  test('keeps a per-product window when it says something different', () => {
    // Act
    const windows = grokWindows(
      billingBody({ productUsage: [{ product: 'GrokBuild', usagePercent: 12 }] }),
    );

    // Assert — `7d <name>` is what the TUI normalizes to 7days_<name>
    expect(windows.map((w) => w.id)).toEqual(['weekly', '7d GrokBuild']);
    expect(windows[1]?.usedPercent).toBe(12);
  });

  test('never invents a window from a body it does not recognize', () => {
    // Act & Assert
    expect(grokWindows({})).toEqual([]);
    expect(grokWindows({ config: {} })).toEqual([]);
    expect(grokWindows({ config: { creditUsagePercent: 'lots' } })).toEqual([]);
  });

  test('omits the on-demand spend axis while its unit is unverified', () => {
    // Act
    const windows = grokWindows(
      billingBody({ onDemandCap: { val: 5000 }, onDemandUsed: { val: 1200 } }),
    );

    // Assert
    expect(windows.map((w) => w.id)).toEqual(['weekly']);
  });
});

describe('fetchGrokQuota', () => {
  beforeEach(() => {
    resetGrokQuotaState();
  });

  test('reads the billing route with our own user agent, not the CLI impersonation', async () => {
    // Arrange
    const { fetchFn, calls } = responder(200, billingBody());

    // Act
    const snapshot = await fetchGrokQuota({ credential: credential(), nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure).toBeNull();
    expect(snapshot.agent).toBe('grok');
    expect(snapshot.accountId).toBe('user-uuid-1');
    expect(snapshot.windows.map((w) => w.id)).toEqual(['weekly']);
    expect(calls[0]?.url).toBe('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('llmtally/');
    expect(headers['x-grok-client-identifier']).toBeUndefined();
  });

  test('skips the request entirely when the session token already expired', async () => {
    // Arrange
    const { fetchFn, calls } = responder(200, billingBody());

    // Act
    const snapshot = await fetchGrokQuota({
      credential: credential({ expiresAtUtc: NOW - 10 }),
      nowUtc: NOW,
      fetchFn,
    });

    // Assert — unavailable (not auth_invalid) so stored history survives
    expect(calls).toEqual([]);
    expect(snapshot.failure?.kind).toBe('unavailable');
    expect(snapshot.warnings[0]).toContain('run "grok" once');
  });

  test('reports a vendor refusal as auth_invalid, which does discard history', async () => {
    // Arrange
    const { fetchFn } = responder(401, { error: 'unauthorized' });

    // Act
    const snapshot = await fetchGrokQuota({ credential: credential(), nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure?.kind).toBe('auth_invalid');
    expect(snapshot.warnings[0]).toContain('grok login');
  });

  test('stops calling a route that answered 404 and keeps history alive', async () => {
    // Arrange
    const { fetchFn, calls } = responder(404, 'gone');

    // Act
    const first = await fetchGrokQuota({ credential: credential(), nowUtc: NOW, fetchFn });
    const second = await fetchGrokQuota({ credential: credential(), nowUtc: NOW + 400, fetchFn });

    // Assert — unavailable, so the stored numbers stay on screen
    expect(first.failure?.kind).toBe('unavailable');
    expect(second.failure?.kind).toBe('unavailable');
    expect(calls).toHaveLength(1);
  });

  test('carries the vendor retry hint on a 429', async () => {
    // Arrange
    const { fetchFn } = responder(429, 'slow down', { 'Retry-After': '90' });

    // Act
    const snapshot = await fetchGrokQuota({ credential: credential(), nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure?.kind).toBe('rate_limited');
    expect(snapshot.retryAfterSeconds).toBe(90);
  });

  test('treats an unrecognized body as transport, never as zero usage', async () => {
    // Arrange
    const { fetchFn } = responder(200, { config: { somethingElse: true } });

    // Act
    const snapshot = await fetchGrokQuota({ credential: credential(), nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.failure?.kind).toBe('transport');
    expect(snapshot.windows).toEqual([]);
  });

  test('never lets the token reach a warning string', async () => {
    // Arrange — a transport error whose message quotes the URL and token
    const fetchFn = (): Promise<Response> => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    };

    // Act
    const snapshot = await fetchGrokQuota({ credential: credential(), nowUtc: NOW, fetchFn });

    // Assert
    expect(snapshot.warnings[0]).toContain('<redacted>');
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
  });
});

describe('grokQuotaSubject and expiry', () => {
  test('the budget key follows the token, so a renewal gets a fresh budget', () => {
    // Act
    const before = grokQuotaSubject({ accessToken: 'token-a', accountId: 'u1', account: null });
    const after = grokQuotaSubject({ accessToken: 'token-b', accountId: 'u1', account: null });

    // Assert
    expect(before.key).not.toBe(after.key);
    expect(before.key).not.toContain('token-a');
    expect(before.agent).toBe('grok');
  });

  test('a token without an expiry is never treated as expired', () => {
    // Act & Assert
    expect(isGrokTokenExpired(credential({ expiresAtUtc: null }), NOW)).toBe(false);
    expect(isGrokTokenExpired(credential({ expiresAtUtc: NOW + 3600 }), NOW)).toBe(false);
    // inside the skew buffer counts as expired
    expect(isGrokTokenExpired(credential({ expiresAtUtc: NOW + 30 }), NOW)).toBe(true);
  });
});
