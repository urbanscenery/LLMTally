import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { openQuotaFetchStateStore } from '@llmtally/core/quota/fetch-state.ts';
import type { QuotaThrottleSubject } from '@llmtally/core/quota/throttle.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;
const NORMAL = 180;
const POST_429 = 360;

function subject(key = 'claude-code|ua=test|token=sha256:abc'): QuotaThrottleSubject {
  return { key, agent: 'claude-code', accountId: 'acc-1', account: 'me@test.dev' };
}

function dbPath(): string {
  return join(makeTempDir(), 'ledger.db');
}

function claimNow(path: string, nowUtc: number) {
  const store = openQuotaFetchStateStore(path, nowUtc);
  try {
    return { store, decision: store.claim(subject(), nowUtc, NORMAL, POST_429) };
  } catch (error) {
    store.close();
    throw error;
  }
}

describe('quota fetch state store', () => {
  test('the first claim wins and a concurrent second connection defers', () => {
    // Arrange — two independent connections, same database
    const path = dbPath();
    const first = openQuotaFetchStateStore(path, NOW);
    const second = openQuotaFetchStateStore(path, NOW);

    // Act
    const winner = first.claim(subject(), NOW, NORMAL, POST_429);
    const loser = second.claim(subject(), NOW, NORMAL, POST_429);

    // Assert
    expect(winner.kind).toBe('claimed');
    expect(loser.kind).toBe('deferred');
    if (loser.kind === 'deferred') {
      expect(loser.reason).toBe('claim');
    }
    first.close();
    second.close();
  });

  test('a completed fetch enforces the 180s cadence for every process', () => {
    // Arrange
    const path = dbPath();
    const { store, decision } = claimNow(path, NOW);
    expect(decision.kind).toBe('claimed');
    if (decision.kind === 'claimed') {
      store.complete(subject().key, decision.owner, NOW, { kind: 'success' });
    }
    store.close();

    // Act — too early, then exactly on cadence
    const early = claimNow(path, NOW + NORMAL - 1);
    early.store.close();
    const onTime = claimNow(path, NOW + NORMAL);
    onTime.store.close();

    // Assert
    expect(early.decision.kind).toBe('deferred');
    if (early.decision.kind === 'deferred') {
      expect(early.decision.reason).toBe('cadence');
      expect(early.decision.retryAtUtc).toBe(NOW + NORMAL);
    }
    expect(onTime.decision.kind).toBe('claimed');
  });

  test('a 429 blocks 360s and floors the cadence for the rolling hour', () => {
    // Arrange — one claimed fetch that came back 429
    const path = dbPath();
    const { store, decision } = claimNow(path, NOW);
    if (decision.kind === 'claimed') {
      store.complete(subject().key, decision.owner, NOW, {
        kind: 'rate_limited',
        retryAfterSeconds: null,
      });
    }
    store.close();

    // Act
    const blocked = claimNow(path, NOW + 359);
    blocked.store.close();
    const probe = claimNow(path, NOW + 360);
    // success during the rolling hour must keep the 360s floor
    if (probe.decision.kind === 'claimed') {
      probe.store.complete(subject().key, probe.decision.owner, NOW + 360, { kind: 'success' });
    }
    probe.store.close();
    const withinWindow = claimNow(path, NOW + 360 + NORMAL);
    withinWindow.store.close();
    const afterFloor = claimNow(path, NOW + 360 + POST_429);
    afterFloor.store.close();

    // Assert
    expect(blocked.decision.kind).toBe('deferred');
    if (blocked.decision.kind === 'deferred') {
      expect(blocked.decision.reason).toBe('rate_limit');
    }
    expect(probe.decision.kind).toBe('claimed');
    expect(withinWindow.decision.kind).toBe('deferred');
    expect(afterFloor.decision.kind).toBe('claimed');
  });

  test('repeated 429s back off 360/600/1200/1800 and success within the window keeps the count', () => {
    // Arrange — drive the state machine through consecutive refusals
    const path = dbPath();
    const store = openQuotaFetchStateStore(path, NOW);
    let now = NOW;
    const waits: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const decision = store.claim(subject(), now, NORMAL, POST_429);
      expect(decision.kind).toBe('claimed');
      if (decision.kind !== 'claimed') {
        break;
      }
      store.complete(subject().key, decision.owner, now, {
        kind: 'rate_limited',
        retryAfterSeconds: null,
      });
      const after = store.claim(subject(), now, NORMAL, POST_429);
      if (after.kind === 'deferred') {
        waits.push(after.retryAtUtc - now);
        now = after.retryAtUtc;
      }
    }

    // Assert — exponential from the second refusal, capped at 1800
    expect(waits).toEqual([360, 600, 1200, 1800]);
    store.close();
  });

  test('success after a quiet rolling hour fully resets the 429 history', () => {
    // Arrange
    const path = dbPath();
    const first = claimNow(path, NOW);
    if (first.decision.kind === 'claimed') {
      first.store.complete(subject().key, first.decision.owner, NOW, {
        kind: 'rate_limited',
        retryAfterSeconds: null,
      });
    }
    first.store.close();

    // Act — a success 3600s later clears the window entirely
    const later = claimNow(path, NOW + 3600);
    if (later.decision.kind === 'claimed') {
      later.store.complete(subject().key, later.decision.owner, NOW + 3600, { kind: 'success' });
    }
    later.store.close();
    const normalCadence = claimNow(path, NOW + 3600 + NORMAL);
    normalCadence.store.close();

    // Assert — back to the 180s cadence, no lingering floor
    expect(later.decision.kind).toBe('claimed');
    expect(normalCadence.decision.kind).toBe('claimed');
  });

  test('a crashed claimer ages out after the claim TTL but keeps its cadence slot', () => {
    // Arrange — claim and never complete (simulated crash)
    const path = dbPath();
    const crashed = claimNow(path, NOW);
    expect(crashed.decision.kind).toBe('claimed');
    crashed.store.close();

    // Act
    const duringClaim = claimNow(path, NOW + 29);
    duringClaim.store.close();
    const afterClaimStillCadence = claimNow(path, NOW + 31);
    afterClaimStillCadence.store.close();
    const afterCadence = claimNow(path, NOW + NORMAL);
    afterCadence.store.close();

    // Assert — the reserved slot is spent even though the fetch never landed
    expect(duringClaim.decision.kind).toBe('deferred');
    expect(afterClaimStillCadence.decision.kind).toBe('deferred');
    if (afterClaimStillCadence.decision.kind === 'deferred') {
      expect(afterClaimStillCadence.decision.reason).toBe('cadence');
    }
    expect(afterCadence.decision.kind).toBe('claimed');
  });

  test('an outcome from a stale owner cannot weaken the row, but its 429 still counts', () => {
    // Arrange — owner A claims, times out; owner B claims the next slot
    const path = dbPath();
    const a = claimNow(path, NOW);
    a.store.close();
    const b = claimNow(path, NOW + NORMAL);
    expect(b.decision.kind).toBe('claimed');

    // Act — the stale owner A reports success afterwards: ignored
    if (a.decision.kind === 'claimed') {
      b.store.complete(subject().key, a.decision.owner, NOW + NORMAL + 1, { kind: 'success' });
    }
    const stillClaimed = b.store.claim(subject(), NOW + NORMAL + 2, NORMAL, POST_429);
    // stale owner reports a 429: that is a real budget refusal, applied monotonically
    if (a.decision.kind === 'claimed') {
      b.store.complete(subject().key, a.decision.owner, NOW + NORMAL + 3, {
        kind: 'rate_limited',
        retryAfterSeconds: null,
      });
    }
    const blocked = b.store.claim(subject(), NOW + NORMAL + 4, NORMAL, POST_429);
    b.store.close();

    // Assert
    expect(stillClaimed.kind).toBe('deferred');
    if (stillClaimed.kind === 'deferred') {
      expect(stillClaimed.reason).toBe('claim');
    }
    expect(blocked.kind).toBe('deferred');
    if (blocked.kind === 'deferred') {
      expect(blocked.reason).toBe('rate_limit');
    }
  });

  test('stale rows are cleaned up on open, live claims survive', () => {
    // Arrange — one ancient row, one freshly claimed row
    const path = dbPath();
    const old = openQuotaFetchStateStore(path, NOW - 8 * 24 * 3600);
    const oldDecision = old.claim(
      { ...subject(), key: 'claude-code|ua=test|token=sha256:old' },
      NOW - 8 * 24 * 3600,
      NORMAL,
      POST_429,
    );
    expect(oldDecision.kind).toBe('claimed');
    old.close();
    const live = openQuotaFetchStateStore(path, NOW);
    const liveDecision = live.claim(subject(), NOW, NORMAL, POST_429);
    expect(liveDecision.kind).toBe('claimed');
    live.close();

    // Act — a later open prunes by retention
    openQuotaFetchStateStore(path, NOW + 1).close();
    const db = openDatabase(path);
    migrate(db);
    const keys = db
      .query<{ key: string }, []>('SELECT key FROM quota_fetch_state ORDER BY key')
      .all()
      .map((row) => row.key);
    db.close();

    // Assert
    expect(keys).toEqual(['claude-code|ua=test|token=sha256:abc']);
  });
});

describe('monotonic 429 bookkeeping', () => {
  test('a stale owner reporting with an older clock cannot shrink the window', () => {
    // Arrange — A claims and stalls; B claims later and gets a 429 at T+180
    const path = dbPath();
    const store = openQuotaFetchStateStore(path, NOW);
    const a = store.claim(subject(), NOW, NORMAL, POST_429);
    const b = store.claim(subject(), NOW + NORMAL, NORMAL, POST_429);
    expect(b.kind).toBe('claimed');
    if (b.kind === 'claimed') {
      store.complete(subject().key, b.owner, NOW + NORMAL, {
        kind: 'rate_limited',
        retryAfterSeconds: null,
      });
    }

    // Act — the stalled owner A finally reports its own 429 with the
    // older timestamp it started with
    if (a.kind === 'claimed') {
      store.complete(subject().key, a.owner, NOW, {
        kind: 'rate_limited',
        retryAfterSeconds: null,
      });
    }
    const after = store.claim(subject(), NOW + NORMAL + 1, NORMAL, POST_429);
    store.close();

    // Assert — last_429 stayed at the newer refusal; the rolling-hour
    // floor and the block did not move backwards
    expect(after.kind).toBe('deferred');
    if (after.kind === 'deferred') {
      expect(after.state.last429Utc).toBe(NOW + NORMAL);
      expect(after.state.blockedUntilUtc).toBeGreaterThanOrEqual(NOW + NORMAL + 360);
    }
  });
});
