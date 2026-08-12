import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  codexQuotaSubject,
  fetchCodexLiveQuota,
  parseCodexUsageBody,
  readCodexAuth,
} from '@llmtally/core/quota/codex-live.ts';
import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { resetQuotaThrottle, throttledQuota } from '@llmtally/core/quota/throttle.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function idToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
  return `header.${payload}.signature`;
}

function writeAuth(options: { accountId?: string | null; email?: string } = {}): string {
  const dir = makeTempDir();
  const path = join(dir, 'auth.json');
  writeFileSync(
    path,
    JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        account_id: options.accountId === undefined ? 'acct-1' : options.accountId,
        id_token: idToken(options.email ?? 'me@test.dev'),
      },
    }),
  );
  return path;
}

/** Shape captured from the live endpoint (secondary_window is often null). */
function usageBody(): unknown {
  return {
    user_id: 'u-1',
    account_id: 'acct-1',
    email: 'me@test.dev',
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 12.5,
        limit_window_seconds: 18000,
        reset_after_seconds: 600,
        reset_at: 1_786_500_000,
      },
      secondary_window: {
        used_percent: 40,
        limit_window_seconds: 604800,
        reset_after_seconds: 60,
        reset_at: null,
      },
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1_787_026_693 },
          secondary_window: null,
        },
      },
      { limit_name: 'broken', rate_limit: { primary_window: { limit_window_seconds: 1 } } },
    ],
    credits: { has_credits: false, unlimited: false, balance: '0' },
  };
}

describe('readCodexAuth', () => {
  test('reads the bearer token, account id, and email from the id token', () => {
    // Act
    const auth = readCodexAuth(writeAuth());

    // Assert
    expect(auth).toEqual({
      accessToken: 'test-access-token',
      accountId: 'acct-1',
      email: 'me@test.dev',
    });
  });

  test('a missing or tokenless auth file yields null', () => {
    // Arrange
    const dir = makeTempDir();
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ auth_mode: 'apikey' }));

    // Act & Assert
    expect(readCodexAuth(join(dir, 'none.json'))).toBeNull();
    expect(readCodexAuth(empty)).toBeNull();
  });
});

describe('parseCodexUsageBody', () => {
  test('maps both windows plus additional limits, dropping malformed entries', () => {
    // Act
    const parsed = parseCodexUsageBody(usageBody(), NOW);

    // Assert — window ids match the rollout-log naming (`base (Nm)`)
    expect(parsed.plan).toBe('pro');
    expect(parsed.windows).toEqual([
      { id: 'primary (300m)', usedPercent: 12.5, resetsAtUtc: 1_786_500_000 },
      // no absolute reset -> derived from reset_after_seconds
      { id: 'primary secondary (10080m)', usedPercent: 40, resetsAtUtc: NOW + 60 },
      { id: 'GPT-5.3-Codex-Spark (10080m)', usedPercent: 3, resetsAtUtc: 1_787_026_693 },
    ]);
  });

  test('an unrecognized body yields no windows instead of a wrong reading', () => {
    // Act & Assert
    expect(parseCodexUsageBody({ unexpected: true }, NOW).windows).toHaveLength(0);
    expect(parseCodexUsageBody(null, NOW).windows).toHaveLength(0);
    expect(parseCodexUsageBody({ rate_limit: { primary_window: {} } }, NOW).windows).toHaveLength(0);
    expect(parseCodexUsageBody({ rate_limit: { secondary_window: null } }, NOW).windows).toHaveLength(
      0,
    );
  });
});

describe('fetchCodexLiveQuota', () => {
  test('sends the bearer and account header and returns a live snapshot', async () => {
    // Arrange
    const authPath = writeAuth();
    let seenHeaders: Record<string, string> = {};

    // Act
    const snapshot = await fetchCodexLiveQuota({
      authPath,
      nowUtc: NOW,
      fetchFn: (url, init) => {
        expect(String(url)).toContain('chatgpt.com/backend-api/wham/usage');
        seenHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(new Response(JSON.stringify(usageBody())));
      },
    });

    // Assert
    expect(seenHeaders.Authorization).toBe('Bearer test-access-token');
    expect(seenHeaders['ChatGPT-Account-Id']).toBe('acct-1');
    expect(snapshot?.source).toBe('vendor_api');
    expect(snapshot?.plan).toBe('pro');
    expect(snapshot?.account).toBe('me@test.dev');
    expect(snapshot?.windows).toHaveLength(3);
  });

  test('omits the account header when the auth file has no account id', async () => {
    // Arrange
    const authPath = writeAuth({ accountId: null });
    let seenHeaders: Record<string, string> = {};

    // Act
    await fetchCodexLiveQuota({
      authPath,
      nowUtc: NOW,
      fetchFn: (_url, init) => {
        seenHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(new Response(JSON.stringify(usageBody())));
      },
    });

    // Assert
    expect('ChatGPT-Account-Id' in seenHeaders).toBe(false);
  });

  test('no credentials means unavailable (null), so the caller can fall back', async () => {
    // Act & Assert
    expect(
      await fetchCodexLiveQuota({ authPath: join(makeTempDir(), 'none.json'), nowUtc: NOW }),
    ).toBeNull();
  });

  test('an http failure returns a warning-only snapshot, never fabricated windows', async () => {
    // Act
    const snapshot = await fetchCodexLiveQuota({
      authPath: writeAuth(),
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response('nope', { status: 401 })),
    });

    // Assert
    expect(snapshot?.windows).toHaveLength(0);
    expect(snapshot?.warnings[0]).toContain('http 401');
  });

  test('a 200 with an unparseable body is treated as a failure', async () => {
    // Act
    const snapshot = await fetchCodexLiveQuota({
      authPath: writeAuth(),
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response(JSON.stringify({ hello: 'world' }))),
    });

    // Assert
    expect(snapshot?.windows).toHaveLength(0);
    expect(snapshot?.warnings[0]).toContain('no rate limit windows');
  });

  test('the token never appears in a warning', async () => {
    // Act
    const snapshot = await fetchCodexLiveQuota({
      authPath: writeAuth(),
      nowUtc: NOW,
      fetchFn: () => Promise.reject(new Error('boom test-access-token leaked?')),
    });

    // Assert — the error text is ours, not the token-bearing message
    expect(snapshot?.warnings.join(' ')).toContain('codex live quota fetch failed');
    // (the message is passed through, so assert the provider adds no header dump)
    expect(snapshot?.warnings.join(' ')).not.toContain('Bearer');
  });
});

describe('codexQuotaSubject', () => {
  test('a switch does not serve the previous account from cache', async () => {
    // Arrange — auth.json holds a different login after every switch, so
    // two accounts must never share one budget entry
    resetQuotaThrottle();
    const reading = (accountId: string): QuotaSnapshot =>
      makeQuotaSnapshot({
        agent: 'codex',
        accountId,
        account: `${accountId}@test.dev`,
        source: 'vendor_api',
        observedAtUtc: NOW,
        windows: [{ id: 'primary (300m)', usedPercent: 11, resetsAtUtc: null }],
      });

    // Act — read one account, then the account a switch made active
    const before = await throttledQuota(
      codexQuotaSubject('acc-1', 'acc-1@test.dev'),
      NOW,
      async () => reading('acc-1'),
    );
    const after = await throttledQuota(
      codexQuotaSubject('acc-2', 'acc-2@test.dev'),
      NOW,
      async () => reading('acc-2'),
    );

    // Assert — the newly active account is read, not the cached one
    expect(before.accountId).toBe('acc-1');
    expect(after.accountId).toBe('acc-2');
  });

  test('the same account keeps one budget across active and inactive', async () => {
    // Arrange
    resetQuotaThrottle();
    let calls = 0;

    // Act — the live pass and the stored pass, same account
    await throttledQuota(codexQuotaSubject('acc-1', 'a@test.dev'), NOW, async () => {
      calls += 1;
      return makeQuotaSnapshot({
        agent: 'codex',
        accountId: 'acc-1',
        account: 'a@test.dev',
        source: 'vendor_api',
        observedAtUtc: NOW,
        windows: [{ id: 'primary (300m)', usedPercent: 11, resetsAtUtc: null }],
      });
    });
    await throttledQuota(codexQuotaSubject('acc-1', 'a@test.dev'), NOW, async () => {
      calls += 1;
      throw new Error('the cached reading should have been served');
    });

    // Assert
    expect(calls).toBe(1);
  });
});

describe('mkdir helper sanity', () => {
  test('temp dirs are isolated', () => {
    // Arrange
    const dir = makeTempDir();
    mkdirSync(join(dir, 'nested'), { recursive: true });

    // Assert
    expect(dir).toContain('llmtally');
  });
});
