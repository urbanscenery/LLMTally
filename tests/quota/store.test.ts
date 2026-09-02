import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import {
  readStoredLastGood,
  recordQuotaSamples,
  upsertAccountProfiles,
} from '@llmtally/core/quota/store.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function openMigrated(): Database {
  const db = new Database(':memory:', { strict: true });
  migrate(db);
  return db;
}

function claudeSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'claude-code',
    account: 'me@test.dev',
    source: 'vendor_api',
    observedAtUtc: NOW - 60,
    windows: [
      { id: 'five_hour', usedPercent: 42, resetsAtUtc: NOW + 3600 },
      { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
    ],
    ...overrides,
  });
}

describe('recordQuotaSamples / readStoredLastGood', () => {
  test('samples round-trip into a stored_history snapshot', () => {
    // Arrange
    const db = openMigrated();

    // Act
    const inserted = recordQuotaSamples(db, [claudeSnapshot()], NOW);
    const stored = readStoredLastGood(db, { agent: 'claude-code', accountId: null, account: 'me@test.dev', nowUtc: NOW + 1800, failure: null });

    // Assert
    expect(inserted).toBe(2);
    expect(stored?.source).toBe('stored_history');
    expect(stored?.observedAtUtc).toBe(NOW - 60);
    expect(stored?.windows).toEqual([
      { id: 'five_hour', usedPercent: 42, resetsAtUtc: NOW + 3600 },
      { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
    ]);
  });

  test('drops a window whose own period already rolled over', () => {
    // Arrange — the five_hour window resets an hour before this read
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW);

    // Act
    const stored = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: null,
      account: 'me@test.dev',
      nowUtc: NOW + 7200,
      failure: null,
    });

    // Assert — utilization went to zero at the boundary, so serving the
    // old percentage next to "resets soon" would read as current
    expect(stored?.windows.map((window) => window.id)).toEqual(['seven_day']);
    expect(stored?.warnings.some((warning) => warning.includes('h old'))).toBe(true);
  });

  test('re-recording the same observation is idempotent', () => {
    // Arrange
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW);

    // Act & Assert
    expect(recordQuotaSamples(db, [claudeSnapshot()], NOW + 60)).toBe(0);
  });

  test('the latest observation per window wins', () => {
    // Arrange
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW);
    recordQuotaSamples(
      db,
      [
        claudeSnapshot({
          observedAtUtc: NOW,
          windows: [{ id: 'five_hour', usedPercent: 55, resetsAtUtc: NOW + 3000 }],
        }),
      ],
      NOW,
    );

    // Act
    const stored = readStoredLastGood(db, { agent: 'claude-code', accountId: null, account: 'me@test.dev', nowUtc: NOW + 60, failure: null });

    // Assert — five_hour advanced; seven_day still from the earlier pass
    expect(stored?.windows).toEqual([
      { id: 'five_hour', usedPercent: 55, resetsAtUtc: NOW + 3000 },
      { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
    ]);
  });

  test('readings older than 24h are not served as fallback', () => {
    // Arrange
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW);

    // Act & Assert
    expect(readStoredLastGood(db, { agent: 'claude-code', accountId: null, account: 'me@test.dev', nowUtc: NOW + 25 * 3600, failure: null })).toBeNull();
  });

  test('retention GC drops samples recorded more than 30 days ago', () => {
    // Arrange
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW - 31 * 24 * 3600);

    // Act — any later write triggers GC
    recordQuotaSamples(
      db,
      [claudeSnapshot({ account: 'other@test.dev', observedAtUtc: NOW })],
      NOW,
    );

    // Assert
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM quota_samples').get();
    expect(count?.n).toBe(2);
    expect(readStoredLastGood(db, { agent: 'claude-code', accountId: null, account: 'me@test.dev', nowUtc: NOW, failure: null })).toBeNull();
  });

  test('a 429 extends trust to the window reset, but only with a sane future reset', () => {
    // Arrange — samples observed 30h ago: past the 24h shelf life
    const db = openMigrated();
    const observed = NOW - 30 * 3600;
    recordQuotaSamples(
      db,
      [
        claudeSnapshot({
          accountId: 'acc-1',
          observedAtUtc: observed,
          windows: [
            // seven_day resets in the future → trusted under a 429
            { id: 'seven_day', usedPercent: 61, resetsAtUtc: NOW + 2 * 24 * 3600 },
            // five_hour reset already passed → its usage restarted, drop it
            { id: 'five_hour', usedPercent: 42, resetsAtUtc: observed + 5 * 3600 },
            // reset-less window → nothing bounds its validity, drop it
            { id: 'extra usage', usedPercent: 3, resetsAtUtc: null },
          ],
        }),
      ],
      observed,
    );
    const rateLimited = {
      kind: 'rate_limited' as const,
      failedAtUtc: NOW,
      retryAtUtc: NOW + 360,
    };

    // Act
    const under429 = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'acc-1',
      account: 'me@test.dev',
      nowUtc: NOW,
      failure: rateLimited,
    });
    const underTransport = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'acc-1',
      account: 'me@test.dev',
      nowUtc: NOW,
      failure: { kind: 'transport', failedAtUtc: NOW, retryAtUtc: null },
    });

    // Assert — only the 429, and only the window whose reset is ahead
    expect(under429?.windows.map((window) => window.id)).toEqual(['seven_day']);
    expect(under429?.accountId).toBe('acc-1');
    expect(under429?.warnings.join(' ')).toContain('cannot have decreased');
    expect(underTransport).toBeNull();
  });

  test('an absurdly distant reset does not extend 429 trust', () => {
    // Arrange
    const db = openMigrated();
    const observed = NOW - 30 * 3600;
    recordQuotaSamples(
      db,
      [
        claudeSnapshot({
          observedAtUtc: observed,
          windows: [{ id: 'seven_day', usedPercent: 61, resetsAtUtc: NOW + 40 * 24 * 3600 }],
        }),
      ],
      observed,
    );

    // Act & Assert — a reset 40 days out is damage, not information
    expect(
      readStoredLastGood(db, {
        agent: 'claude-code',
        accountId: null,
        account: 'me@test.dev',
        nowUtc: NOW,
        failure: { kind: 'rate_limited', failedAtUtc: NOW, retryAtUtc: null },
      }),
    ).toBeNull();
  });

  test('the latest-window lookup walks the covering index, not a quadratic re-scan', () => {
    // Arrange — enough history that the correlated-MAX form visibly
    // degraded (delta review D-03: 1.3s p95 at 40k rows)
    const db = openMigrated();
    const insert = db.prepare(
      `INSERT INTO quota_samples
        (agent, account, account_id, window_id, used_percent, resets_at_utc, source, observed_at_utc, recorded_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, 'vendor_api', ?, ?)`,
    );
    db.exec('BEGIN;');
    for (let account = 0; account < 40; account += 1) {
      for (const window of ['five_hour', 'seven_day', 'monthly', '7d Fable']) {
        for (let reading = 0; reading < 250; reading += 1) {
          const observed = NOW - 23 * 3600 + reading * 60;
          insert.run(
            'claude-code',
            `acct-${account}@test.dev`,
            `uuid-${account}`,
            window,
            reading % 100,
            NOW + 7200,
            observed,
            observed,
          );
        }
      }
    }
    db.exec('COMMIT;');

    // Act
    const startedAt = performance.now();
    const stored = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'uuid-7',
      account: 'acct-7@test.dev',
      nowUtc: NOW,
      failure: null,
    });
    const elapsedMs = performance.now() - startedAt;

    // Assert — newest reading per window, and the plan is index-driven
    expect(stored?.windows).toHaveLength(4);
    expect(stored?.observedAtUtc).toBe(NOW - 23 * 3600 + 249 * 60);
    expect(elapsedMs).toBeLessThan(500);
    const plan = db
      .query<{ detail: string }, [string, string]>(
        `EXPLAIN QUERY PLAN
         SELECT window_id FROM (
           SELECT window_id,
                  ROW_NUMBER() OVER (PARTITION BY window_id ORDER BY observed_at_utc DESC) AS recency
           FROM quota_samples WHERE agent = ? AND account_id = ?
         ) WHERE recency = 1`,
      )
      .all('claude-code', 'uuid-7')
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toContain('idx_quota_samples_latest_by_id');
  });

  test('an id-carrying reader never inherits id-less rows via the label', () => {
    // Arrange — samples recorded before ids existed carry '' and share
    // the display label; the same label can belong to another account
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW);

    // Act & Assert — attribution by label alone is how one account's
    // numbers end up under another; the id-less rows just age out
    expect(
      readStoredLastGood(db, {
        agent: 'claude-code',
        accountId: 'acc-1',
        account: 'me@test.dev',
        nowUtc: NOW + 60,
        failure: null,
      }),
    ).toBeNull();
  });

  test('two accounts sharing a label keep separate histories, found by id', () => {
    // Arrange — personal + organization on one email, read in the same
    // load (identical observed_at second)
    const db = openMigrated();
    const shared = { account: 'me@test.dev', observedAtUtc: NOW };
    recordQuotaSamples(
      db,
      [
        claudeSnapshot({
          ...shared,
          accountId: 'uuid-personal',
          windows: [{ id: 'five_hour', usedPercent: 10, resetsAtUtc: null }],
        }),
        claudeSnapshot({
          ...shared,
          accountId: 'uuid-org',
          windows: [{ id: 'five_hour', usedPercent: 90, resetsAtUtc: null }],
        }),
      ],
      NOW,
    );

    // Act
    const personal = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'uuid-personal',
      account: 'me@test.dev',
      nowUtc: NOW + 60,
      failure: null,
    });
    const org = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'uuid-org',
      account: 'me@test.dev',
      nowUtc: NOW + 60,
      failure: null,
    });

    // Assert — neither sample was lost to the unique key
    expect(personal?.windows[0]?.usedPercent).toBe(10);
    expect(org?.windows[0]?.usedPercent).toBe(90);
  });

  test('accounts are isolated from each other', () => {
    // Arrange
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW);

    // Act & Assert
    expect(readStoredLastGood(db, { agent: 'claude-code', accountId: null, account: 'other@test.dev', nowUtc: NOW, failure: null })).toBeNull();
    expect(readStoredLastGood(db, { agent: 'codex', accountId: null, account: 'me@test.dev', nowUtc: NOW, failure: null })).toBeNull();
  });
});

describe('upsertAccountProfiles', () => {
  test('inserts then updates while preserving first_seen', () => {
    // Arrange
    const db = openMigrated();
    const profile = {
      agent: 'claude-code',
      accountId: 'uuid-1',
      displayLabel: 'me@test.dev',
      email: 'me@test.dev',
      organizationId: 'org-1',
      discoveredVia: 'claude-config' as const,
    };

    // Act
    upsertAccountProfiles(db, [profile], NOW);
    upsertAccountProfiles(db, [{ ...profile, displayLabel: 'me@test.dev [work]' }], NOW + 100);

    // Assert
    const row = db
      .query<{ display_label: string; first_seen_utc: number; last_seen_utc: number }, []>(
        'SELECT display_label, first_seen_utc, last_seen_utc FROM account_profiles',
      )
      .get();
    expect(row).toEqual({
      display_label: 'me@test.dev [work]',
      first_seen_utc: NOW,
      last_seen_utc: NOW + 100,
    });
  });
});

describe('discoverAccounts', () => {
  test('collects one profile per agent store with a stable id', () => {
    // Arrange — claude config, codex auth, antigravity store
    const home = makeTempDir();
    const claudeConfig = join(home, '.claude.json');
    writeFileSync(
      claudeConfig,
      JSON.stringify({
        oauthAccount: {
          accountUuid: 'uuid-active',
          emailAddress: 'active@test.dev',
          organizationUuid: 'org-1',
        },
      }),
    );
    const codexAuth = join(home, 'auth.json');
    const payload = Buffer.from(JSON.stringify({ email: 'codex@test.dev' })).toString('base64url');
    writeFileSync(
      codexAuth,
      JSON.stringify({ tokens: { account_id: 'codex-acc-1', id_token: `x.${payload}.y` } }),
    );
    const antigravityStore = join(home, 'antigravity');
    mkdirSync(join(antigravityStore, 'accounts', 'agy@test.dev'), { recursive: true });

    const opencodeAuth = join(home, 'opencode-auth.json');
    writeFileSync(
      opencodeAuth,
      JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-test' } }),
    );

    // Act
    const profiles = discoverAccounts({
      claudeConfigPath: claudeConfig,
      codexAuthPath: codexAuth,
      antigravityStoreDir: antigravityStore,
      opencodeAuthPath: opencodeAuth,
      grokAuthPath: join(home, 'grok-auth.json'),
      cursorCliHome: home,
    });

    // Assert
    const keys = profiles.map((profile) => `${profile.agent}:${profile.accountId}`);
    expect(keys).toHaveLength(4);
    expect(keys.slice(0, 3)).toEqual([
      'claude-code:uuid-active',
      'codex:codex-acc-1',
      'antigravity:agy@test.dev',
    ]);
    expect(keys[3]).toMatch(/^opencode:opencode-go\.[0-9a-f]{6}$/);
    expect(profiles[0]?.discoveredVia).toBe('claude-config');
    expect(profiles[0]?.displayLabel).toBe('active@test.dev');
    expect(profiles[1]?.email).toBe('codex@test.dev');
  });

  test('missing stores discover nothing without throwing', () => {
    // Arrange
    const home = makeTempDir();

    // Act & Assert
    expect(
      discoverAccounts({
        claudeConfigPath: join(home, 'none.json'),
        codexAuthPath: join(home, 'none-auth.json'),
        antigravityStoreDir: join(home, 'none-store'),
        opencodeAuthPath: join(home, 'none-opencode.json'),
        grokAuthPath: join(home, 'none-grok.json'),
        cursorCliHome: home,
      }),
    ).toEqual([]);
  });
});

describe('readStoredLastGood and a rejected credential', () => {
  test('a refused credential cannot keep vouching for its old numbers', () => {
    // Arrange — a good reading recorded moments ago
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot({ accountId: 'acc-1' })], NOW - 60);

    // Act — the same account, but the vendor has now rejected the key
    const stale = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'acc-1',
      account: 'me@test.dev',
      nowUtc: NOW,
      failure: { kind: 'auth_invalid', failedAtUtc: NOW, retryAtUtc: null },
    });

    // Assert — the numbers may still be true, but nothing can confirm it
    expect(stale).toBeNull();
    db.close();
  });

  test('a transient failure still gets the last good reading', () => {
    // Arrange — same history, a network problem instead of a refusal
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot({ accountId: 'acc-1' })], NOW - 60);

    // Act
    const stored = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'acc-1',
      account: 'me@test.dev',
      nowUtc: NOW,
      failure: { kind: 'transport', failedAtUtc: NOW, retryAtUtc: null },
    });

    // Assert
    expect(stored?.source).toBe('stored_history');
    expect(stored?.windows).toHaveLength(2);
    db.close();
  });
});

describe('account_mismatch and rejection diagnostics', () => {
  test('trusted history still serves a gauge under account_mismatch', () => {
    // Arrange
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot({ accountId: 'uuid-a' })], NOW - 60);

    // Act — the selected account is mismatch-refused but its OWN stored
    // numbers stay trustworthy (unlike auth_invalid)
    const stored = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'uuid-a',
      account: 'me@test.dev',
      nowUtc: NOW,
      failure: {
        kind: 'account_mismatch',
        failedAtUtc: NOW,
        retryAtUtc: null,
        credentialOwner: { accountId: 'uuid-b', account: 'other@test.dev' },
      },
    });

    // Assert
    expect(stored).not.toBeNull();
    expect(stored?.windows.map((window) => window.id)).toEqual(['five_hour', 'seven_day']);
  });

  test('a fully rejected history names the reason', () => {
    // Arrange — one window past its reset, one aged out past 24h
    const db = openMigrated();
    recordQuotaSamples(
      db,
      [
        claudeSnapshot({
          accountId: 'uuid-a',
          observedAtUtc: NOW - 100_000,
          windows: [
            { id: 'five_hour', usedPercent: 42, resetsAtUtc: NOW - 10 },
            { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
          ],
        }),
      ],
      NOW - 100_000,
    );

    // Act
    const rejectionNotes: string[] = [];
    const stored = readStoredLastGood(
      db,
      {
        agent: 'claude-code',
        accountId: 'uuid-a',
        account: 'me@test.dev',
        nowUtc: NOW,
        failure: { kind: 'transport', failedAtUtc: NOW, retryAtUtc: null },
      },
      rejectionNotes,
    );

    // Assert — the blank gauge explains itself
    expect(stored).toBeNull();
    expect(rejectionNotes).toHaveLength(1);
    expect(rejectionNotes[0]).toMatch(/past their reset/);
    expect(rejectionNotes[0]).toMatch(/older than 24h/);
  });
});
