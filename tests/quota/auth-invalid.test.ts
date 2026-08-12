import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { migrate } from '@llmtally/core/db/migrate.ts';
import { openQuotaFetchStateStore } from '@llmtally/core/quota/fetch-state.ts';
import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { readStoredLastGood, recordQuotaSamples } from '@llmtally/core/quota/store.ts';
import { resetQuotaThrottle, throttledQuota } from '@llmtally/core/quota/throttle.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const CADENCE = 300;
const SUBJECT = { key: 'opencode-go|k', agent: 'opencode', accountId: 'bundle-a', account: 'bundle-a' };

function good(nowUtc: number): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'opencode',
    accountId: 'bundle-a',
    account: 'bundle-a',
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [{ id: 'monthly', usedPercent: 43, resetsAtUtc: nowUtc + 86_400 }],
  });
}

function refused(nowUtc: number): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'opencode',
    accountId: 'bundle-a',
    account: 'bundle-a',
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: { kind: 'auth_invalid', failedAtUtc: nowUtc, retryAtUtc: null },
    warnings: ['the vendor rejected the stored key'],
  });
}

beforeEach(() => {
  resetQuotaThrottle();
});

/**
 * The whole point of `auth_invalid`: once the vendor refuses a
 * credential, nothing may keep showing the numbers it produced — not
 * the process cache, not the stored history, and not a later read that
 * is merely waiting out the polling cadence.
 */
describe('a refused credential across the cadence window', () => {
  function harness() {
    const databasePath = join(makeTempDir(), 'ledger.db');
    const db = new Database(databasePath, { create: true, strict: true });
    migrate(db);
    return { databasePath, db };
  }

  test('the deferred read after a refusal does not resurrect stored history', async () => {
    // Arrange — a good reading is recorded, then the key is refused
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    recordQuotaSamples(db, [good(NOW)], NOW);
    await throttledQuota(SUBJECT, NOW, async () => good(NOW), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });
    await throttledQuota(SUBJECT, NOW + CADENCE, async () => refused(NOW + CADENCE), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });

    // Act — a second later, still inside the cadence, a fresh process asks
    resetQuotaThrottle();
    const later = openQuotaFetchStateStore(databasePath, NOW + CADENCE + 1);
    const deferred = await throttledQuota(
      SUBJECT,
      NOW + CADENCE + 1,
      async () => {
        throw new Error('must not reach the vendor inside the cadence');
      },
      { ttlSeconds: CADENCE, stateStore: later },
    );
    const fallback = readStoredLastGood(db, {
      agent: 'opencode',
      accountId: 'bundle-a',
      account: 'bundle-a',
      nowUtc: NOW + CADENCE + 1,
      failure: deferred.failure,
    });

    // Assert — the wait keeps the refusal's name, so the history that
    // would otherwise fill the gap is refused too
    expect(deferred.failure?.kind).toBe('auth_invalid');
    expect(deferred.windows).toEqual([]);
    expect(fallback).toBeNull();
    store.close();
    later.close();
    db.close();
  });

  test('a successful read clears the refusal for good', async () => {
    // Arrange
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    await throttledQuota(SUBJECT, NOW, async () => refused(NOW), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });

    // Act — the user signs in again and the next allowed read succeeds
    const healed = await throttledQuota(
      SUBJECT,
      NOW + CADENCE,
      async () => good(NOW + CADENCE),
      { ttlSeconds: CADENCE, stateStore: store },
    );
    resetQuotaThrottle();
    const afterHealing = await throttledQuota(
      SUBJECT,
      NOW + CADENCE + 1,
      async () => {
        throw new Error('must not reach the vendor inside the cadence');
      },
      { ttlSeconds: CADENCE, stateStore: store },
    );

    // Assert — an ordinary wait again, so history may serve it
    expect(healed.failure).toBeNull();
    expect(afterHealing.failure?.kind).toBe('deferred');
    store.close();
    db.close();
  });

  test('a transient failure is still an ordinary wait afterwards', async () => {
    // Arrange — the difference must come from the refusal, not from
    // any failure having happened at all
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    const broken = makeQuotaSnapshot({
      agent: 'opencode',
      accountId: 'bundle-a',
      account: 'bundle-a',
      source: 'vendor_api',
      observedAtUtc: NOW,
      windows: [],
      failure: { kind: 'transport', failedAtUtc: NOW, retryAtUtc: null },
    });
    await throttledQuota(SUBJECT, NOW, async () => broken, {
      ttlSeconds: CADENCE,
      stateStore: store,
    });

    // Act
    resetQuotaThrottle();
    const deferred = await throttledQuota(
      SUBJECT,
      NOW + 1,
      async () => {
        throw new Error('must not reach the vendor inside the cadence');
      },
      { ttlSeconds: CADENCE, stateStore: store },
    );

    // Assert
    expect(deferred.failure?.kind).toBe('deferred');
    store.close();
    db.close();
  });

  test('without a shared store the refusal still throttles re-checking', async () => {
    // Arrange — a process with no ledger must not re-ask the vendor on
    // every repaint just because the reading came back empty
    let calls = 0;
    const fetchRefused = async (): Promise<QuotaSnapshot> => {
      calls += 1;
      return refused(NOW);
    };

    // Act
    await throttledQuota(SUBJECT, NOW, fetchRefused, { ttlSeconds: CADENCE });
    const repaint = await throttledQuota(SUBJECT, NOW + 1, fetchRefused, { ttlSeconds: CADENCE });

    // Assert
    expect(calls).toBe(1);
    expect(repaint.failure?.kind).toBe('auth_invalid');
    expect(repaint.windows).toEqual([]);
  });
});
