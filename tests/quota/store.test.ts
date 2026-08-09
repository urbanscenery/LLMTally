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
    const stored = readStoredLastGood(db, 'claude-code', 'me@test.dev', NOW + 7200);

    // Assert
    expect(inserted).toBe(2);
    expect(stored?.source).toBe('stored_history');
    expect(stored?.observedAtUtc).toBe(NOW - 60);
    expect(stored?.windows).toEqual([
      { id: 'five_hour', usedPercent: 42, resetsAtUtc: NOW + 3600 },
      { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
    ]);
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
    const stored = readStoredLastGood(db, 'claude-code', 'me@test.dev', NOW + 60);

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
    expect(readStoredLastGood(db, 'claude-code', 'me@test.dev', NOW + 25 * 3600)).toBeNull();
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
    expect(readStoredLastGood(db, 'claude-code', 'me@test.dev', NOW)).toBeNull();
  });

  test('accounts are isolated from each other', () => {
    // Arrange
    const db = openMigrated();
    recordQuotaSamples(db, [claudeSnapshot()], NOW);

    // Act & Assert
    expect(readStoredLastGood(db, 'claude-code', 'other@test.dev', NOW)).toBeNull();
    expect(readStoredLastGood(db, 'codex', 'me@test.dev', NOW)).toBeNull();
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

    // Act
    const profiles = discoverAccounts({
      claudeConfigPath: claudeConfig,
      codexAuthPath: codexAuth,
      antigravityStoreDir: antigravityStore,
    });

    // Assert
    const keys = profiles.map((profile) => `${profile.agent}:${profile.accountId}`);
    expect(keys).toEqual([
      'claude-code:uuid-active',
      'codex:codex-acc-1',
      'antigravity:agy@test.dev',
    ]);
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
      }),
    ).toEqual([]);
  });
});
