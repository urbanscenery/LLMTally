import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { makeQuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { openQuotaFetchStateStore } from '@llmtally/core/quota/fetch-state.ts';
import {
  QUOTA_CACHE_TTL_SECONDS,
  accessTokenFingerprint,
  claudeQuotaSubject,
  resetQuotaThrottle,
  softResetQuotaThrottle,
  throttledQuota,
} from '@llmtally/core/quota/throttle.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const TTL = QUOTA_CACHE_TTL_SECONDS;

function good(usedPercent = 10, nowUtc = NOW): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'claude-code',
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [{ id: 'five_hour', usedPercent, resetsAtUtc: null }],
  });
}

function limited(retryAfterSeconds: number | null = null, nowUtc = NOW): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: 'claude-code',
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: {
      kind: 'rate_limited',
      failedAtUtc: nowUtc,
      retryAtUtc: retryAfterSeconds === null ? null : nowUtc + retryAfterSeconds,
    },
    retryAfterSeconds,
    warnings: ['claude usage endpoint returned 429 (rate limited)'],
  });
}

describe('quota throttle', () => {
  beforeEach(() => {
    resetQuotaThrottle();
  });

  test('a second read inside the 180s window reuses the first reading', async () => {
    // Arrange
    let calls = 0;
    const fetchOnce = async (): Promise<QuotaSnapshot> => {
      calls += 1;
      return good(calls * 10);
    };

    // Act
    const first = await throttledQuota('claude-code', NOW, fetchOnce);
    const second = await throttledQuota('claude-code', NOW + TTL - 1, fetchOnce);

    // Assert
    expect(calls).toBe(1);
    expect(second.windows[0]?.usedPercent).toBe(first.windows[0]?.usedPercent);
  });

  test('the window expires so numbers do keep moving', async () => {
    // Arrange
    let calls = 0;
    const fetchOnce = async (): Promise<QuotaSnapshot> => {
      calls += 1;
      return good(calls * 10);
    };

    // Act
    await throttledQuota('claude-code', NOW, fetchOnce);
    const later = await throttledQuota('claude-code', NOW + TTL, fetchOnce);

    // Assert
    expect(calls).toBe(2);
    expect(later.windows[0]?.usedPercent).toBe(20);
  });

  test('a 429 keeps the last good numbers, annotated with the current failure', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => good(42));

    // Act — the vendor refuses the next attempt
    const after = await throttledQuota('claude-code', NOW + TTL, async () => limited());

    // Assert — data survives, and the failure is structured, not a flag
    expect(after.windows[0]?.usedPercent).toBe(42);
    expect(after.failure?.kind).toBe('rate_limited');
    expect(after.rateLimited).toBe(true);
    expect(after.warnings.join(' ')).toContain('rate limited; retrying in');
  });

  test('the endpoint is not called again while backing off', async () => {
    // Arrange — a refusal blocks at least 360s
    await throttledQuota('claude-code', NOW, async () => limited());
    let calls = 0;

    // Act
    await throttledQuota('claude-code', NOW + 359, async () => {
      calls += 1;
      return good();
    });

    // Assert
    expect(calls).toBe(0);
  });

  test('backoff grows with repeated refusals inside the rolling hour', async () => {
    // Arrange — first refusal waits 360s; refuse again right after it
    await throttledQuota('claude-code', NOW, async () => limited());
    await throttledQuota('claude-code', NOW + 360, async () => limited(null, NOW + 360));

    // Act — the second refusal waits 600s, so 599s later is still blocked
    let calls = 0;
    await throttledQuota('claude-code', NOW + 360 + 599, async () => {
      calls += 1;
      return good();
    });

    // Assert
    expect(calls).toBe(0);
  });

  test('a vendor retry-after longer than our backoff is honoured', async () => {
    // Act
    const snapshot = await throttledQuota('claude-code', NOW, async () => limited(3600));

    // Assert
    expect(snapshot.warnings.join(' ')).toContain('60m');
  });

  test('success inside the rolling hour keeps the 360s floor, not the 180s cadence', async () => {
    // Arrange — one refusal, then a successful probe when the block ends
    await throttledQuota('claude-code', NOW, async () => limited());
    await throttledQuota('claude-code', NOW + 360, async () => good(7, NOW + 360));

    // Act — 180s later the endpoint must NOT be called (floor is 360s)
    let calls = 0;
    await throttledQuota('claude-code', NOW + 360 + TTL, async () => {
      calls += 1;
      return good();
    });
    const floorCalls = calls;
    await throttledQuota('claude-code', NOW + 360 + 360, async () => {
      calls += 1;
      return good(9, NOW + 720);
    });

    // Assert
    expect(floorCalls).toBe(0);
    expect(calls).toBe(1);
  });

  test('a quiet rolling hour after a 429 restores the normal cadence', async () => {
    // Arrange — refusal, then success after the window has fully aged out
    await throttledQuota('claude-code', NOW, async () => limited());
    await throttledQuota('claude-code', NOW + 3601, async () => good(7, NOW + 3601));

    // Act — normal 180s cadence applies again
    let calls = 0;
    await throttledQuota('claude-code', NOW + 3601 + TTL, async () => {
      calls += 1;
      return good(9);
    });

    // Assert
    expect(calls).toBe(1);
  });

  test('soft reset drops freshness but never the 429 block', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => limited());
    softResetQuotaThrottle();

    // Act — still blocked despite the reset
    let calls = 0;
    const during = await throttledQuota('claude-code', NOW + 10, async () => {
      calls += 1;
      return good();
    });

    // Assert
    expect(calls).toBe(0);
    expect(during.warnings.join(' ')).toContain('rate limited');
  });

  test('soft reset after a good reading allows an immediate re-read', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => good(5));
    softResetQuotaThrottle();

    // Act
    let calls = 0;
    await throttledQuota('claude-code', NOW + 1, async () => {
      calls += 1;
      return good(6);
    });

    // Assert — freshness gone, so the read goes out (stateless mode)
    expect(calls).toBe(1);
  });

  test('keys are independent, so one vendor cannot block another', async () => {
    // Arrange
    await throttledQuota('claude-code', NOW, async () => limited());
    let calls = 0;

    // Act
    await throttledQuota('codex', NOW + 1, async () => {
      calls += 1;
      return good();
    });

    // Assert
    expect(calls).toBe(1);
  });

  test('concurrent calls in one process share a single in-flight fetch', async () => {
    // Arrange
    let calls = 0;
    const slow = (): Promise<QuotaSnapshot> =>
      new Promise((resolve) => {
        calls += 1;
        setTimeout(() => {
          resolve(good(11));
        }, 10);
      });

    // Act
    const [a, b] = await Promise.all([
      throttledQuota('claude-code', NOW, slow),
      throttledQuota('claude-code', NOW, slow),
    ]);

    // Assert
    expect(calls).toBe(1);
    expect(a.windows[0]?.usedPercent).toBe(11);
    expect(b.windows[0]?.usedPercent).toBe(11);
  });
});

describe('quota throttle with a persistent state store', () => {
  beforeEach(() => {
    resetQuotaThrottle();
  });

  function subject() {
    return claudeQuotaSubject({
      accessToken: 'token-abc',
      accountId: 'acc-1',
      account: 'me@test.dev',
    });
  }

  test('a restarted process inherits the shared cadence instead of refetching', async () => {
    // Arrange — first process fetches and exits
    const path = join(makeTempDir(), 'ledger.db');
    const store1 = openQuotaFetchStateStore(path, NOW);
    await throttledQuota(subject(), NOW, async () => good(30), { stateStore: store1 });
    store1.close();

    // Act — "restart": process memory gone, DB remembers the slot
    resetQuotaThrottle();
    const store2 = openQuotaFetchStateStore(path, NOW + 60);
    let calls = 0;
    const deferred = await throttledQuota(
      subject(),
      NOW + 60,
      async () => {
        calls += 1;
        return good(31);
      },
      { stateStore: store2 },
    );
    store2.close();

    // Assert — no fetch; the read is deferred, not failed
    expect(calls).toBe(0);
    expect(deferred.failure?.kind).toBe('deferred');
    expect(deferred.agent).toBe('claude-code');
    expect(deferred.accountId).toBe('acc-1');
  });

  test('a persisted 429 block survives a restart and reports the wait', async () => {
    // Arrange
    const path = join(makeTempDir(), 'ledger.db');
    const store1 = openQuotaFetchStateStore(path, NOW);
    await throttledQuota(subject(), NOW, async () => limited(), { stateStore: store1 });
    store1.close();

    // Act — restart during the block
    resetQuotaThrottle();
    const store2 = openQuotaFetchStateStore(path, NOW + 60);
    let calls = 0;
    const held = await throttledQuota(
      subject(),
      NOW + 60,
      async () => {
        calls += 1;
        return good();
      },
      { stateStore: store2 },
    );
    store2.close();

    // Assert
    expect(calls).toBe(0);
    expect(held.failure?.kind).toBe('rate_limited');
    expect(held.warnings.join(' ')).toContain('retrying in');
  });

  test('an unavailable state store means no vendor call at all', async () => {
    // Act
    let calls = 0;
    const snapshot = await throttledQuota(
      subject(),
      NOW,
      async () => {
        calls += 1;
        return good();
      },
      { stateStoreUnavailable: true },
    );

    // Assert — fail toward under-spending the budget
    expect(calls).toBe(0);
    expect(snapshot.failure?.kind).toBe('deferred');
    expect(snapshot.warnings.join(' ')).toContain('state store unavailable');
  });
});

describe('budget key construction', () => {
  test('the key carries a fingerprint, never the raw token', () => {
    // Act
    const subject = claudeQuotaSubject({
      accessToken: 'sk-ant-oat01-super-secret',
      accountId: 'acc-1',
      account: 'me@test.dev',
    });

    // Assert
    expect(subject.key).not.toContain('super-secret');
    expect(subject.key).toContain('token=sha256:');
    expect(subject.key).toContain('ua=llmtally/');
  });

  test('rotation changes the fingerprint, same token stays stable', () => {
    // Act & Assert
    expect(accessTokenFingerprint('token-a')).toBe(accessTokenFingerprint('token-a'));
    expect(accessTokenFingerprint('token-a')).not.toBe(accessTokenFingerprint('token-b'));
    expect(accessTokenFingerprint('token-a')).toMatch(/^sha256:[0-9a-f]{24}$/);
  });
});

describe('429 metadata and restart inheritance', () => {
  beforeEach(() => {
    resetQuotaThrottle();
  });

  test('the first 429 without a cache reports the wait we actually enforce', async () => {
    // Act — vendor sends retry-after: 0-equivalent (null)
    const refused = await throttledQuota('claude-code', NOW, async () => limited());

    // Assert — failure carries our 360s floor, not the vendor's zero
    expect(refused.failure?.retryAtUtc).toBe(NOW + 360);
    expect(refused.rateLimited).toBe(true);
  });

  test('a restarted process inherits the persisted 429 count for its backoff', async () => {
    // Arrange — one refusal recorded in the shared store, then a restart
    const path = join(makeTempDir(), 'ledger.db');
    const subject = () =>
      claudeQuotaSubject({ accessToken: 't', accountId: 'acc-1', account: 'a@test.dev' });
    const store1 = openQuotaFetchStateStore(path, NOW);
    await throttledQuota(subject(), NOW, async () => limited(), { stateStore: store1 });
    store1.close();
    resetQuotaThrottle();

    // Act — after the 360s block, the next fetch is refused again
    const store2 = openQuotaFetchStateStore(path, NOW + 360);
    const second = await throttledQuota(
      subject(),
      NOW + 360,
      async () => limited(null, NOW + 360),
      { stateStore: store2 },
    );
    store2.close();

    // Assert — the second refusal in the rolling hour waits 600s, which
    // only happens if the restart inherited count=1 from the store
    expect(second.failure?.retryAtUtc).toBe(NOW + 360 + 600);
  });

  test('a throwing state store defers instead of free-running', async () => {
    // Arrange
    const broken = {
      claim: () => {
        throw new Error('disk gone');
      },
      complete: () => undefined,
      close: () => undefined,
    };

    // Act
    let calls = 0;
    const snapshot = await throttledQuota(
      claudeQuotaSubject({ accessToken: 't', accountId: null, account: null }),
      NOW,
      async () => {
        calls += 1;
        return good();
      },
      { stateStore: broken },
    );

    // Assert
    expect(calls).toBe(0);
    expect(snapshot.failure?.kind).toBe('deferred');
  });
});

describe('throttledQuota and a rejected credential', () => {
  beforeEach(() => {
    resetQuotaThrottle();
  });

  function refused(nowUtc = NOW): QuotaSnapshot {
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: nowUtc,
      windows: [],
      failure: { kind: 'auth_invalid', failedAtUtc: nowUtc, retryAtUtc: null },
      warnings: ['the vendor rejected the stored key'],
    });
  }

  test('forgets the cached numbers instead of serving them under a refusal', async () => {
    // Arrange — a good reading is cached, then the key stops working
    await throttledQuota('k', NOW, async () => good(42));

    // Act
    const afterRefusal = await throttledQuota('k', NOW + TTL + 1, async () => refused(NOW + TTL + 1));
    const nextRead = await throttledQuota('k', NOW + TTL + 2, async () => refused(NOW + TTL + 2));

    // Assert — neither the refusal itself nor the read right after it
    // may show numbers nobody stands behind any more
    expect(afterRefusal.windows).toEqual([]);
    expect(afterRefusal.failure?.kind).toBe('auth_invalid');
    expect(nextRead.windows).toEqual([]);
  });

  test('a transport failure still keeps the last good numbers on screen', async () => {
    // Arrange
    await throttledQuota('k2', NOW, async () => good(42));
    const broken = makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: NOW + TTL + 1,
      windows: [],
      failure: { kind: 'transport', failedAtUtc: NOW + TTL + 1, retryAtUtc: null },
    });

    // Act
    const snapshot = await throttledQuota('k2', NOW + TTL + 1, async () => broken);

    // Assert
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.failure?.kind).toBe('transport');
  });

  test('a recovered credential repopulates the cache normally', async () => {
    // Arrange
    await throttledQuota('k3', NOW, async () => good(42));
    await throttledQuota('k3', NOW + TTL + 1, async () => refused(NOW + TTL + 1));

    // Act — the user logs back in and the next read succeeds
    const healed = await throttledQuota('k3', NOW + 2 * TTL + 2, async () => good(7, NOW + 2 * TTL + 2));

    // Assert
    expect(healed.failure).toBeNull();
    expect(healed.windows[0]?.usedPercent).toBe(7);
  });

  test('a slower cadence governs the shared claim, not just the local cache', async () => {
    // Arrange — two independent processes sharing one budget file
    const databasePath = join(makeTempDir(), 'ledger.db');
    const storeA = openQuotaFetchStateStore(databasePath, NOW);
    const storeB = openQuotaFetchStateStore(databasePath, NOW);
    let calls = 0;
    const fetchOnce = async (): Promise<QuotaSnapshot> => {
      calls += 1;
      return good(10);
    };
    const subject = { key: 'slow', agent: 'opencode', accountId: null, account: null };

    // Act — the second process asks after the default 180s but inside 300s
    await throttledQuota(subject, NOW, fetchOnce, {
      ttlSeconds: 300,
      stateStore: storeA,
    });
    resetQuotaThrottle('slow');
    const second = await throttledQuota(subject, NOW + 200, fetchOnce, {
      ttlSeconds: 300,
      stateStore: storeB,
    });

    // Assert — the shared claim must honour the adapter's cadence
    expect(calls).toBe(1);
    expect(second.failure?.kind).toBe('deferred');
    storeA.close();
    storeB.close();
  });
});

/**
 * ClinePass only learns whose numbers it read by resolving `/users/me`
 * during the call. A cold process whose first pass is deferred by the
 * shared cadence therefore holds nothing but a credential label — and
 * the stored history, written under the real account, became
 * unreachable, so the card rendered with no gauge.
 */
describe('identity learned during a read outlives the process', () => {
  const subject = {
    key: 'cline-pass|ua=test|key=sha256:abc',
    agent: 'cline',
    accountId: null,
    account: 'cline-pass.opencode-go.84bf4d',
  };

  function identified(nowUtc: number): QuotaSnapshot {
    return makeQuotaSnapshot({
      agent: 'cline',
      accountId: 'usr-01KYV',
      account: 'me@test.dev',
      source: 'vendor_api',
      observedAtUtc: nowUtc,
      windows: [{ id: 'weekly', usedPercent: 4, resetsAtUtc: nowUtc + 86_400 }],
    });
  }

  beforeEach(() => {
    resetQuotaThrottle();
  });

  test('a deferred read in a fresh process is labelled with the account, not the credential', async () => {
    // Arrange — one successful read records the identity it resolved
    const stateStore = openQuotaFetchStateStore(join(makeTempDir(), 'ledger.db'), NOW);
    const first = await throttledQuota(subject, NOW, async () => identified(NOW), { stateStore });
    expect(first.accountId).toBe('usr-01KYV');

    // Act — a new process shares the store but has no in-memory cache,
    // and the cadence defers it before it can call
    resetQuotaThrottle();
    const deferred = await throttledQuota(
      subject,
      NOW + 5,
      async () => {
        throw new Error('must not call the vendor inside the cadence');
      },
      { stateStore },
    );

    // Assert — the empty snapshot can still find its own history
    expect(deferred.failure?.kind).toBe('deferred');
    expect(deferred.windows).toEqual([]);
    expect(deferred.accountId).toBe('usr-01KYV');
    expect(deferred.account).toBe('me@test.dev');
    stateStore.close();
  });

  test('a placeholder never overwrites an identity a read already recorded', async () => {
    // Arrange
    const stateStore = openQuotaFetchStateStore(join(makeTempDir(), 'ledger.db'), NOW);
    await throttledQuota(subject, NOW, async () => identified(NOW), { stateStore });

    // Act — a later claim carries the credential label again
    resetQuotaThrottle();
    await throttledQuota(subject, NOW + 10_000, async () => identified(NOW + 10_000), {
      stateStore,
    });
    resetQuotaThrottle();
    const deferred = await throttledQuota(subject, NOW + 10_005, async () => identified(NOW), {
      stateStore,
    });

    // Assert
    expect(deferred.accountId).toBe('usr-01KYV');
    expect(deferred.account).toBe('me@test.dev');
    stateStore.close();
  });
});
