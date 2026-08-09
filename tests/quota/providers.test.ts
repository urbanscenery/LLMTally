import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchClaudeQuota, readCodexQuota } from '@llmtally/core/quota/providers.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

describe('fetchClaudeQuota', () => {
  test('parses window utilizations from the oauth usage endpoint', async () => {
    // Arrange
    const body = {
      five_hour: { utilization: 91.0, resets_at: '2026-08-10T16:00:00+00:00' },
      seven_day: { utilization: 40.0, resets_at: '2026-08-10T22:00:00+00:00' },
      seven_day_opus: null,
    };
    let sawAuth = false;

    // Act
    const snapshot = await fetchClaudeQuota({
      tokenReader: () => 'test-token',
      accountReader: () => 'me@test.dev',
      nowUtc: NOW,
      fetchFn: (url, init) => {
        const headers = init?.headers as Record<string, string>;
        sawAuth = headers.Authorization === 'Bearer test-token';
        expect(url).toContain('api.anthropic.com');
        return Promise.resolve(new Response(JSON.stringify(body)));
      },
    });

    // Assert
    expect(sawAuth).toBe(true);
    expect(snapshot.windows).toEqual([
      {
        id: 'five_hour',
        usedPercent: 91.0,
        resetsAtUtc: Math.floor(Date.parse('2026-08-10T16:00:00+00:00') / 1000),
      },
      {
        id: 'seven_day',
        usedPercent: 40.0,
        resetsAtUtc: Math.floor(Date.parse('2026-08-10T22:00:00+00:00') / 1000),
      },
    ]);
    expect(snapshot.warnings).toHaveLength(0);
    expect(snapshot.account).toBe('me@test.dev');
  });

  test('parses model-scoped weekly limits and the extra-usage axis', async () => {
    // Arrange
    const body = {
      five_hour: { utilization: 10.0, resets_at: null },
      limits: [
        {
          scope: { model: { display_name: 'Fable' } },
          percent: 3.5,
          resets_at: '2026-08-14T00:00:00+00:00',
        },
        { scope: {}, percent: 99 },
      ],
      extra_usage: {
        is_enabled: true,
        used_credits: 1250,
        monthly_limit: 10000,
        utilization: 12.5,
        resets_at: '2026-09-01T00:00:00+00:00',
      },
    };

    // Act
    const snapshot = await fetchClaudeQuota({
      tokenReader: () => 'test-token',
      accountReader: () => null,
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response(JSON.stringify(body))),
    });

    // Assert — malformed scoped entry dropped, credits rendered in dollars
    expect(snapshot.windows.map((window) => window.id)).toEqual([
      'five_hour',
      '7d Fable',
      'extra usage $13/$100',
    ]);
    expect(snapshot.windows[1]).toMatchObject({ usedPercent: 3.5 });
    expect(snapshot.windows[2]).toMatchObject({ usedPercent: 12.5 });
  });

  test('a disabled extra-usage axis is not shown', async () => {
    // Arrange
    const body = {
      five_hour: { utilization: 10.0, resets_at: null },
      extra_usage: { is_enabled: false, utilization: 0 },
    };

    // Act
    const snapshot = await fetchClaudeQuota({
      tokenReader: () => 'test-token',
      accountReader: () => null,
      nowUtc: NOW,
      fetchFn: () => Promise.resolve(new Response(JSON.stringify(body))),
    });

    // Assert
    expect(snapshot.windows.map((window) => window.id)).toEqual(['five_hour']);
  });

  test('missing credentials or a failing endpoint degrade to warnings', async () => {
    // Act
    const noToken = await fetchClaudeQuota({
      tokenReader: () => null,
      accountReader: () => null,
      nowUtc: NOW,
    });
    const offline = await fetchClaudeQuota({
      tokenReader: () => 't',
      accountReader: () => null,
      nowUtc: NOW,
      fetchFn: () => Promise.reject(new Error('offline')),
    });

    // Assert
    expect(noToken.windows).toHaveLength(0);
    expect(noToken.warnings[0]).toContain('credentials');
    expect(offline.warnings[0]).toContain('fetch failed');
  });
});

describe('readCodexQuota', () => {
  function rolloutLine(observedAt: string, usedPercent: number): string {
    return JSON.stringify({
      timestamp: observedAt,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1_786_936_972 },
          secondary: null,
          plan_type: 'prolite',
        },
      },
    });
  }

  test('reads the newest rate_limits event from local rollouts without network', () => {
    // Arrange
    const root = makeTempDir();
    mkdirSync(join(root, '2026', '08', '10'), { recursive: true });
    writeFileSync(
      join(root, '2026', '08', '10', 'rollout-a.jsonl'),
      `${rolloutLine('2026-08-10T12:00:00.000Z', 40)}\n${rolloutLine('2026-08-10T13:00:00.000Z', 55)}\n`,
    );

    // Act
    const snapshot = readCodexQuota({ sessionsRoot: root, nowUtc: 1_786_453_260 });

    // Assert — the LAST event in the file wins; staleness is reported
    expect(snapshot.plan).toBe('prolite');
    expect(snapshot.windows[0]).toMatchObject({ usedPercent: 55, resetsAtUtc: 1_786_936_972 });
    expect(snapshot.warnings.some((warning) => warning.includes('minutes old'))).toBe(true);
  });

  test('missing sessions or events yield warnings and no windows', () => {
    // Act
    const snapshot = readCodexQuota({ sessionsRoot: join(makeTempDir(), 'none'), nowUtc: NOW });

    // Assert
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  });
});
