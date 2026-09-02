import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { migrate } from '@llmtally/core/db/migrate.ts';
import {
  NO_SUBSCRIPTION_RECHECK_SECONDS,
  openQuotaFetchStateStore,
} from '@llmtally/core/quota/fetch-state.ts';
import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { readStoredLastGood, recordQuotaSamples } from '@llmtally/core/quota/store.ts';
import { resetQuotaThrottle, throttledQuota } from '@llmtally/core/quota/throttle.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const CADENCE = 300;
const SUBJECT = {
  key: 'claude-code|t',
  agent: 'claude-code',
  accountId: 'acc-1',
  account: 'me@test.dev',
};

function good(nowUtc: number): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'claude-code',
    accountId: 'acc-1',
    account: 'me@test.dev',
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [{ id: 'five_hour', usedPercent: 43, resetsAtUtc: nowUtc + 5 * 3600 }],
  });
}

function lapsed(nowUtc: number): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'claude-code',
    accountId: 'acc-1',
    account: 'me@test.dev',
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    plan: 'free',
    failure: { kind: 'no_subscription', failedAtUtc: nowUtc, retryAtUtc: null },
    warnings: ['no active subscription (free plan)'],
  });
}

beforeEach(() => {
  resetQuotaThrottle();
});

/**
 * A canceled subscription is a state, not a transient failure: the
 * usage endpoint refuses free accounts forever, so the verdict must
 * replace the paid-era numbers (cache AND stored history), survive
 * process restarts, and slow the polling down to a resubscription
 * re-check — never an endless "rate limited, retrying" loop.
 */
describe('a lapsed subscription across the cadence window', () => {
  function harness() {
    const databasePath = join(makeTempDir(), 'ledger.db');
    const db = new Database(databasePath, { create: true, strict: true });
    migrate(db);
    return { databasePath, db };
  }

  test('the deferred read keeps the free-plan verdict and refuses paid-era history', async () => {
    // Arrange — a good (paid-era) reading exists, then the plan lapses
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    recordQuotaSamples(db, [good(NOW)], NOW);
    await throttledQuota(SUBJECT, NOW, async () => good(NOW), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });
    await throttledQuota(SUBJECT, NOW + CADENCE, async () => lapsed(NOW + CADENCE), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });

    // Act — a fresh process asks while the re-check cadence holds
    resetQuotaThrottle();
    const later = openQuotaFetchStateStore(databasePath, NOW + 2 * CADENCE);
    const deferred = await throttledQuota(
      SUBJECT,
      NOW + 2 * CADENCE,
      async () => {
        throw new Error('must not reach the vendor inside the re-check cadence');
      },
      { ttlSeconds: CADENCE, stateStore: later },
    );
    const fallback = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'acc-1',
      account: 'me@test.dev',
      nowUtc: NOW + 2 * CADENCE,
      failure: deferred.failure,
    });

    // Assert — the wait keeps the verdict's name and the paid-era
    // numbers stay gone
    expect(deferred.failure?.kind).toBe('no_subscription');
    expect(deferred.plan).toBe('free');
    expect(deferred.windows).toEqual([]);
    expect(deferred.rateLimited).toBe(false);
    expect(fallback).toBeNull();
    store.close();
    later.close();
    db.close();
  });

  test('an observer process repeats the verdict on every repaint, never a generic deferral', async () => {
    // Arrange — one process records the verdict; ANOTHER process (fresh
    // throttle memory) only ever observes it through the shared store
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    recordQuotaSamples(db, [good(NOW - 60)], NOW - 60);
    await throttledQuota(SUBJECT, NOW, async () => lapsed(NOW), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });
    resetQuotaThrottle();

    // Act — the observer polls twice WITHOUT a reset in between: the
    // second poll answers from the local defer mirror, which must not
    // degrade the verdict to an ordinary wait
    const first = await throttledQuota(
      SUBJECT,
      NOW + 10,
      async () => {
        throw new Error('must not reach the vendor inside the re-check cadence');
      },
      { ttlSeconds: CADENCE, stateStore: store },
    );
    const second = await throttledQuota(
      SUBJECT,
      NOW + 11,
      async () => {
        throw new Error('must not reach the vendor inside the re-check cadence');
      },
      { ttlSeconds: CADENCE, stateStore: store },
    );
    const fallback = readStoredLastGood(db, {
      agent: 'claude-code',
      accountId: 'acc-1',
      account: 'me@test.dev',
      nowUtc: NOW + 11,
      failure: second.failure,
    });

    // Assert — a generic 'deferred' here would slip past the stored-
    // history gate and resurrect the paid-era numbers
    expect(first.failure?.kind).toBe('no_subscription');
    expect(second.failure?.kind).toBe('no_subscription');
    expect(second.plan).toBe('free');
    expect(fallback).toBeNull();
    store.close();
    db.close();
  });

  test('the verdict stretches the cadence to the resubscription re-check', async () => {
    // Arrange
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    await throttledQuota(SUBJECT, NOW, async () => lapsed(NOW), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });

    // Act — well past the normal cadence but inside the slow re-check
    resetQuotaThrottle();
    const insideRecheck = await throttledQuota(
      SUBJECT,
      NOW + NO_SUBSCRIPTION_RECHECK_SECONDS - 1,
      async () => {
        throw new Error('must not reach the vendor inside the re-check cadence');
      },
      { ttlSeconds: CADENCE, stateStore: store },
    );
    let reached = false;
    resetQuotaThrottle();
    await throttledQuota(
      SUBJECT,
      NOW + NO_SUBSCRIPTION_RECHECK_SECONDS,
      async () => {
        reached = true;
        return lapsed(NOW + NO_SUBSCRIPTION_RECHECK_SECONDS);
      },
      { ttlSeconds: CADENCE, stateStore: store },
    );

    // Assert
    expect(insideRecheck.failure?.kind).toBe('no_subscription');
    expect(insideRecheck.failure?.retryAtUtc).toBe(NOW + NO_SUBSCRIPTION_RECHECK_SECONDS);
    expect(reached).toBe(true);
    store.close();
    db.close();
  });

  test('a successful read clears the verdict (the user resubscribed)', async () => {
    // Arrange
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    await throttledQuota(SUBJECT, NOW, async () => lapsed(NOW), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });

    // Act — the re-check finds windows again
    const healedAt = NOW + NO_SUBSCRIPTION_RECHECK_SECONDS;
    const healed = await throttledQuota(SUBJECT, healedAt, async () => good(healedAt), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });
    resetQuotaThrottle();
    const afterHealing = await throttledQuota(
      SUBJECT,
      healedAt + 1,
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

  test('a plain rate_limited verdict retires an older free-plan mark', async () => {
    // Arrange — the account was free; later the probe stops saying so
    // (resubscribed, but the usage endpoint 429s this once for real)
    const { databasePath, db } = harness();
    const store = openQuotaFetchStateStore(databasePath, NOW);
    await throttledQuota(SUBJECT, NOW, async () => lapsed(NOW), {
      ttlSeconds: CADENCE,
      stateStore: store,
    });
    const retryAt = NOW + NO_SUBSCRIPTION_RECHECK_SECONDS;
    await throttledQuota(
      SUBJECT,
      retryAt,
      async () =>
        makeQuotaSnapshot({
          agent: 'claude-code',
          accountId: 'acc-1',
          account: 'me@test.dev',
          source: 'vendor_api',
          observedAtUtc: retryAt,
          windows: [],
          failure: { kind: 'rate_limited', failedAtUtc: retryAt, retryAtUtc: null },
        }),
      { ttlSeconds: CADENCE, stateStore: store },
    );

    // Act — the next deferred read must say 429, not "free plan"
    resetQuotaThrottle();
    const deferred = await throttledQuota(
      SUBJECT,
      retryAt + 1,
      async () => {
        throw new Error('must not reach the vendor inside the backoff');
      },
      { ttlSeconds: CADENCE, stateStore: store },
    );

    // Assert
    expect(deferred.failure?.kind).toBe('rate_limited');
    store.close();
    db.close();
  });

  test('without a shared store the verdict still throttles re-checking', async () => {
    // Arrange — a process with no ledger must not re-ask the vendor on
    // every repaint just because the reading came back empty
    let calls = 0;
    const fetchLapsed = async (): Promise<QuotaSnapshot> => {
      calls += 1;
      return lapsed(NOW);
    };

    // Act
    await throttledQuota(SUBJECT, NOW, fetchLapsed, { ttlSeconds: CADENCE });
    const repaint = await throttledQuota(SUBJECT, NOW + 1, fetchLapsed, { ttlSeconds: CADENCE });

    // Assert
    expect(calls).toBe(1);
    expect(repaint.failure?.kind).toBe('no_subscription');
    expect(repaint.plan).toBe('free');
    expect(repaint.windows).toEqual([]);
  });
});
