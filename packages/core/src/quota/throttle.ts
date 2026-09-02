/**
 * Politeness policy for vendor quota endpoints, kept out of the
 * providers so they stay pure request/parse code.
 *
 * The Anthropic usage endpoint budgets requests per access token on a
 * rolling ~60-minute window (~28-30 requests measured); the sustained
 * cadence here (180s → ≤20/hour) stays safely under it, and a 429
 * switches to a 360s floor for a full rolling hour because capacity
 * only returns as old requests age out — pausing does not restore it
 * early. `retry-after` arrives as `0`, so every wait is ours.
 *
 * Process-local state answers repeat reads cheaply; when a
 * `QuotaFetchStateStore` is supplied the atomic claim in SQLite becomes
 * the authority, so every llmtally process (and restart) spends one
 * shared budget. Without a store the same numbers apply per process.
 */
import { makeQuotaSnapshot } from './providers.ts';
import type { QuotaFailure, QuotaSnapshot } from './providers.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import {
  NO_SUBSCRIPTION_RECHECK_SECONDS,
  POST_429_MIN_INTERVAL_SECONDS,
  POST_429_WINDOW_SECONDS,
  rateLimitWaitSeconds,
} from './fetch-state.ts';
import type { QuotaFetchStateStore, QuotaThrottleSubject } from './fetch-state.ts';

export type { QuotaThrottleSubject } from './fetch-state.ts';
export { POST_429_MIN_INTERVAL_SECONDS, rateLimitWaitSeconds } from './fetch-state.ts';

export const QUOTA_CACHE_TTL_SECONDS = 180;

/** Non-secret budget identity: rotation of the token = a fresh budget. */
export function accessTokenFingerprint(accessToken: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(accessToken).digest('hex');
  return `sha256:${hash.slice(0, 24)}`;
}

export function claudeQuotaSubject(input: {
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly account: string | null;
}): QuotaThrottleSubject {
  return {
    key: `claude-code|ua=${LLMTALLY_USER_AGENT}|token=${accessTokenFingerprint(input.accessToken)}`,
    agent: 'claude-code',
    accountId: input.accountId,
    account: input.account,
  };
}

interface ThrottleEntry {
  snapshot: QuotaSnapshot | null;
  cachedAtUtc: number;
  blockedUntilUtc: number;
  consecutiveRateLimits: number;
  lastRateLimitedAtUtc: number | null;
  /** Shared-cadence verdict mirrored locally to avoid re-asking SQLite. */
  deferUntilUtc: number;
  /**
   * The typed verdict (`auth_invalid`/`no_subscription`) behind the
   * current deferral, when there is one. The local mirror must repeat
   * it verbatim: degrading it to a generic `deferred` on the next
   * repaint would slip past the stored-history gate and re-serve the
   * numbers the verdict exists to bury.
   */
  deferSnapshot: QuotaSnapshot | null;
  inFlight: Promise<QuotaSnapshot> | null;
}

const entries = new Map<string, ThrottleEntry>();

function entryFor(key: string): ThrottleEntry {
  const existing = entries.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: ThrottleEntry = {
    snapshot: null,
    cachedAtUtc: 0,
    blockedUntilUtc: 0,
    consecutiveRateLimits: 0,
    lastRateLimitedAtUtc: null,
    deferUntilUtc: 0,
    deferSnapshot: null,
    inFlight: null,
  };
  entries.set(key, created);
  return created;
}

/**
 * Test seam / re-auth escape hatch: drops everything including the 429
 * bookkeeping. Never wire this to a UI refresh — that is what
 * `softResetQuotaThrottle` is for.
 */
export function resetQuotaThrottle(key?: string): void {
  if (key === undefined) {
    entries.clear();
    return;
  }
  entries.delete(key);
}

/**
 * "Get me current numbers" (the TUI `r` key): only the cache freshness
 * is dropped. The 429 block, its counter, and the rolling-hour floor
 * survive — a user hammering refresh must not spend budget the endpoint
 * already refused.
 */
export function softResetQuotaThrottle(key?: string): void {
  if (key === undefined) {
    for (const entry of entries.values()) {
      entry.cachedAtUtc = 0;
    }
    return;
  }
  const entry = entries.get(key);
  if (entry !== undefined) {
    entry.cachedAtUtc = 0;
  }
}

export function describeWait(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s`;
  }
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

export interface ThrottledQuotaOptions {
  readonly ttlSeconds?: number;
  /**
   * Sustained cadence enforced across processes. Defaults to
   * `ttlSeconds` so the in-memory cache and the shared SQLite claim can
   * never disagree about how often a vendor may be called.
   */
  readonly normalIntervalSeconds?: number;
  /** Cross-process budget authority; omit for process-local behavior. */
  readonly stateStore?: QuotaFetchStateStore | null;
  /**
   * True when a store was configured but could not be opened: the
   * budget cannot be coordinated, so no network call is made at all
   * (failing toward under-spending, never over-spending).
   */
  readonly stateStoreUnavailable?: boolean;
}

function asSubject(subject: QuotaThrottleSubject | string): QuotaThrottleSubject {
  return typeof subject === 'string'
    ? { key: subject, agent: subject, accountId: null, account: null }
    : subject;
}

function withCurrentFailure(
  snapshot: QuotaSnapshot,
  failure: QuotaFailure,
  extraWarnings: readonly string[],
): QuotaSnapshot {
  return {
    ...snapshot,
    failure,
    rateLimited: failure.kind === 'rate_limited',
    warnings: [...snapshot.warnings, ...extraWarnings],
  };
}

/**
 * A read that never happened still has to say whose it would have been,
 * or the stored-history fallback cannot find its own rows. The subject
 * only names the budget: for a vendor that reveals identity during the
 * call (ClinePass resolves `/users/me`), a cold process holds nothing
 * but a credential label. The persisted state remembers what the last
 * successful read saw, so it wins over the placeholder.
 */
function emptySnapshot(
  subject: QuotaThrottleSubject,
  nowUtc: number,
  failure: QuotaFailure,
  warnings: readonly string[],
  known?: { readonly accountId: string | null; readonly accountLabel: string | null },
): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: subject.agent,
    accountId: known?.accountId ?? subject.accountId,
    account: known?.accountLabel ?? subject.account,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure,
    warnings,
  });
}

/**
 * Runs `fetch` unless a fresh reading is cached, the endpoint is inside
 * a back-off window, or (with a store) another process holds the claim
 * or the shared cadence says wait. A refused or deferred read never
 * replaces a good cached reading — it annotates it with the current
 * failure, so the dashboard keeps numbers instead of an error.
 */
export async function throttledQuota(
  subjectInput: QuotaThrottleSubject | string,
  nowUtc: number,
  fetchSnapshot: () => Promise<QuotaSnapshot>,
  options: ThrottledQuotaOptions = {},
): Promise<QuotaSnapshot> {
  const subject = asSubject(subjectInput);
  const entry = entryFor(subject.key);
  const inRateLimitWindow =
    entry.lastRateLimitedAtUtc !== null &&
    nowUtc - entry.lastRateLimitedAtUtc < POST_429_WINDOW_SECONDS;
  const cadence = options.ttlSeconds ?? QUOTA_CACHE_TTL_SECONDS;
  const sharedCadence = options.normalIntervalSeconds ?? cadence;
  const ttl = Math.max(cadence, inRateLimitWindow ? POST_429_MIN_INTERVAL_SECONDS : 0);

  if (entry.inFlight !== null) {
    return entry.inFlight;
  }
  if (entry.snapshot !== null && nowUtc - entry.cachedAtUtc < ttl) {
    return entry.snapshot;
  }
  if (nowUtc < entry.blockedUntilUtc) {
    return servedWhileRateLimited(subject, entry, nowUtc, entry.blockedUntilUtc);
  }
  if (options.stateStoreUnavailable === true) {
    const failure: QuotaFailure = { kind: 'deferred', failedAtUtc: nowUtc, retryAtUtc: null };
    const note = 'quota state store unavailable; skipped the vendor call to protect the budget';
    return entry.snapshot === null
      ? emptySnapshot(subject, nowUtc, failure, [note])
      : withCurrentFailure(entry.snapshot, failure, [note]);
  }
  if (nowUtc < entry.deferUntilUtc) {
    // the shared cadence already said "wait": answer from memory instead
    // of opening another SQLite write transaction per repaint. A typed
    // verdict behind the wait is repeated verbatim — reporting it as an
    // ordinary deferral would re-open the stored-history fallback
    if (entry.deferSnapshot !== null) {
      return entry.deferSnapshot;
    }
    const failure: QuotaFailure = {
      kind: 'deferred',
      failedAtUtc: nowUtc,
      retryAtUtc: entry.deferUntilUtc,
    };
    return entry.snapshot === null
      ? emptySnapshot(subject, nowUtc, failure, [])
      : withCurrentFailure(entry.snapshot, failure, []);
  }

  const store = options.stateStore ?? null;
  let owner: string | null = null;
  if (store !== null) {
    let decision;
    try {
      decision = store.claim(subject, nowUtc, sharedCadence, POST_429_MIN_INTERVAL_SECONDS);
    } catch {
      // a broken budget authority means no coordination is possible:
      // fail toward under-spending, exactly like an unopenable store
      const failure: QuotaFailure = { kind: 'deferred', failedAtUtc: nowUtc, retryAtUtc: null };
      const note = 'quota state store failed; skipped the vendor call to protect the budget';
      return entry.snapshot === null
        ? emptySnapshot(subject, nowUtc, failure, [note])
        : withCurrentFailure(entry.snapshot, failure, [note]);
    }
    if (decision.kind === 'deferred') {
      if (decision.state.noSubscriptionAtUtc !== null) {
        // a lapsed plan works like a refusal for display purposes: the
        // wait keeps the verdict's name, and the paid-era numbers must
        // not fill the gap — they describe a subscription that ended
        entry.snapshot = null;
        entry.cachedAtUtc = 0;
        entry.deferUntilUtc = decision.retryAtUtc;
        entry.deferSnapshot = {
          ...emptySnapshot(
            subject,
            nowUtc,
            {
              kind: 'no_subscription',
              failedAtUtc: decision.state.noSubscriptionAtUtc,
              retryAtUtc: decision.retryAtUtc,
            },
            ['no active subscription (free plan) — re-checking for a resubscription on a slow cadence'],
            decision.state,
          ),
          plan: 'free',
        };
        return entry.deferSnapshot;
      }
      if (decision.state.authInvalidAtUtc !== null) {
        // waiting out the cadence after a refusal is not an ordinary
        // wait: reporting it as `deferred` is what lets the stored
        // history fall back in and re-serve the rejected credential's
        // numbers. The refusal keeps its own name until a read succeeds.
        entry.snapshot = null;
        entry.cachedAtUtc = 0;
        entry.deferUntilUtc = decision.retryAtUtc;
        entry.deferSnapshot = emptySnapshot(
          subject,
          nowUtc,
          {
            kind: 'auth_invalid',
            failedAtUtc: decision.state.authInvalidAtUtc,
            retryAtUtc: decision.retryAtUtc,
          },
          ['the vendor rejected this credential; sign in again to restore the reading'],
          decision.state,
        );
        return entry.deferSnapshot;
      }
      // an ordinary deferral means no typed verdict stands any more
      entry.deferSnapshot = null;
      // mirror the shared verdict locally so repeat reads stay cheap
      if (decision.reason === 'rate_limit') {
        entry.blockedUntilUtc = decision.retryAtUtc;
        entry.lastRateLimitedAtUtc = decision.state.last429Utc ?? entry.lastRateLimitedAtUtc;
        entry.consecutiveRateLimits = Math.max(
          entry.consecutiveRateLimits,
          decision.state.consecutive429,
        );
        return servedWhileRateLimited(subject, entry, nowUtc, decision.retryAtUtc);
      }
      entry.deferUntilUtc = decision.retryAtUtc;
      const failure: QuotaFailure = {
        kind: 'deferred',
        failedAtUtc: nowUtc,
        retryAtUtc: decision.retryAtUtc,
      };
      return entry.snapshot === null
        ? emptySnapshot(subject, nowUtc, failure, [], decision.state)
        : withCurrentFailure(entry.snapshot, failure, []);
    }
    owner = decision.owner;
    // a restart must inherit the persisted 429 history, or its next 429
    // would restart the exponential backoff from the beginning
    entry.consecutiveRateLimits = Math.max(
      entry.consecutiveRateLimits,
      decision.state.consecutive429,
    );
    if (decision.state.last429Utc !== null) {
      entry.lastRateLimitedAtUtc = Math.max(
        entry.lastRateLimitedAtUtc ?? 0,
        decision.state.last429Utc,
      );
    }
  }

  const complete = (completion: Parameters<QuotaFetchStateStore['complete']>[3]): void => {
    if (store === null || owner === null) {
      return;
    }
    try {
      store.complete(subject.key, owner, nowUtc, completion);
    } catch {
      // the local bookkeeping below still holds this process back; the
      // shared row heals on the next successful transaction
    }
  };

  const run = (async (): Promise<QuotaSnapshot> => {
    const snapshot = await fetchSnapshot();
    if (snapshot.failure === null) {
      if (!inRateLimitWindow) {
        entry.consecutiveRateLimits = 0;
        entry.lastRateLimitedAtUtc = null;
      }
      entry.snapshot = snapshot;
      entry.cachedAtUtc = nowUtc;
      entry.blockedUntilUtc = 0;
      entry.deferUntilUtc = 0;
      entry.deferSnapshot = null;
      // teach the shared row whose numbers these were, so a later
      // deferred read in any process can still find their history
      complete({ kind: 'success', accountId: snapshot.accountId, account: snapshot.account });
      return snapshot;
    }

    if (snapshot.failure.kind === 'rate_limited') {
      const withinWindow =
        entry.lastRateLimitedAtUtc !== null &&
        nowUtc - entry.lastRateLimitedAtUtc < POST_429_WINDOW_SECONDS;
      entry.consecutiveRateLimits = (withinWindow ? entry.consecutiveRateLimits : 0) + 1;
      entry.lastRateLimitedAtUtc = nowUtc;
      const wait = rateLimitWaitSeconds(entry.consecutiveRateLimits, snapshot.retryAfterSeconds);
      entry.blockedUntilUtc = Math.max(entry.blockedUntilUtc, nowUtc + wait);
      complete({ kind: 'rate_limited', retryAfterSeconds: snapshot.retryAfterSeconds });
      return servedWhileRateLimited(subject, entry, nowUtc, entry.blockedUntilUtc, snapshot);
    }

    if (snapshot.failure.kind === 'no_subscription') {
      // like a refusal, the verdict replaces the cached numbers, and
      // recording it persistently is what stretches the shared cadence
      // to a slow resubscription re-check in every process. The provider
      // cannot know the re-check cadence, so the retry hint is filled in
      // here — the process that made the call should show the same
      // "next check" a deferred observer would.
      complete({ kind: 'no_subscription' });
      const withRetry: QuotaSnapshot = {
        ...snapshot,
        failure: {
          ...snapshot.failure,
          retryAtUtc: snapshot.failure.retryAtUtc ?? nowUtc + NO_SUBSCRIPTION_RECHECK_SECONDS,
        },
      };
      entry.snapshot = withRetry;
      entry.cachedAtUtc = nowUtc;
      entry.deferSnapshot = null;
      return withRetry;
    }

    if (snapshot.failure.kind === 'auth_invalid') {
      // The credential behind those numbers was just refused, so the
      // numbers go and the refusal takes their place in the cache:
      // remembering the refusal is what makes the cadence apply to
      // re-checking a rejected key instead of re-asking on every
      // repaint. Recording it persistently stops the next (deferred)
      // read in any process from bringing the old numbers back.
      complete({ kind: 'auth_invalid' });
      entry.snapshot = snapshot;
      entry.cachedAtUtc = nowUtc;
      entry.deferSnapshot = null;
      return snapshot;
    }
    complete({ kind: 'failure' });
    // transport/unavailable: keep the last good numbers on screen
    return entry.snapshot === null
      ? snapshot
      : withCurrentFailure(entry.snapshot, snapshot.failure, snapshot.warnings);
  })();

  entry.inFlight = run;
  try {
    return await run;
  } finally {
    if (entry.inFlight === run) {
      entry.inFlight = null;
    }
  }
}

function servedWhileRateLimited(
  subject: QuotaThrottleSubject,
  entry: ThrottleEntry,
  nowUtc: number,
  blockedUntilUtc: number,
  freshRefusal?: QuotaSnapshot,
): QuotaSnapshot {
  const note = `${subject.key.split('|')[0] ?? subject.agent} is rate limited; retrying in ${describeWait(blockedUntilUtc - nowUtc)}`;
  const failure: QuotaFailure = {
    kind: 'rate_limited',
    failedAtUtc: entry.lastRateLimitedAtUtc ?? nowUtc,
    retryAtUtc: blockedUntilUtc,
  };
  if (entry.snapshot !== null) {
    return withCurrentFailure(entry.snapshot, failure, [note]);
  }
  if (freshRefusal !== undefined) {
    // the vendor's own retry hint is often `0`; the failure must carry
    // the wait we actually enforce, not the one the vendor suggested
    return { ...freshRefusal, failure, rateLimited: true, warnings: [note] };
  }
  return emptySnapshot(subject, nowUtc, failure, [note]);
}
