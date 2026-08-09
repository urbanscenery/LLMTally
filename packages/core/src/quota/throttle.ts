/**
 * Politeness policy for vendor quota endpoints, kept out of the
 * providers so they stay pure request/parse code.
 *
 * Two problems it solves. A dashboard re-reads quota far more often
 * than the numbers change, so identical calls inside a short window
 * reuse one reading. And once a vendor answers 429, calling again
 * immediately is what keeps it answering 429 — Anthropic's usage
 * endpoint returns `retry-after: 0`, so the wait has to be ours: back
 * off, tell the user how long, and serve the last good reading
 * meanwhile.
 *
 * State is per process. A restart retrying once is acceptable; carrying
 * a stale block across restarts would be worse than one extra request.
 */
import type { QuotaSnapshot } from './providers.ts';

export const QUOTA_CACHE_TTL_SECONDS = 60;
const BASE_BACKOFF_SECONDS = 5 * 60;
const MAX_BACKOFF_SECONDS = 30 * 60;

interface ThrottleEntry {
  snapshot: QuotaSnapshot | null;
  cachedAtUtc: number;
  blockedUntilUtc: number;
  consecutiveRateLimits: number;
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
  };
  entries.set(key, created);
  return created;
}

/** Test seam; also lets a caller drop a block after re-authenticating. */
export function resetQuotaThrottle(key?: string): void {
  if (key === undefined) {
    entries.clear();
    return;
  }
  entries.delete(key);
}

export function describeWait(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s`;
  }
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

/**
 * Runs `fetch` unless a fresh reading is already cached or the endpoint
 * is in a back-off window. A rate-limited answer never replaces a good
 * cached reading — it annotates it, so the dashboard keeps showing
 * numbers instead of an error.
 */
export async function throttledQuota(
  key: string,
  nowUtc: number,
  fetchSnapshot: () => Promise<QuotaSnapshot>,
  options: { readonly ttlSeconds?: number } = {},
): Promise<QuotaSnapshot> {
  const entry = entryFor(key);
  const ttl = options.ttlSeconds ?? QUOTA_CACHE_TTL_SECONDS;

  if (entry.snapshot !== null && nowUtc - entry.cachedAtUtc < ttl) {
    return entry.snapshot;
  }
  if (nowUtc < entry.blockedUntilUtc) {
    const wait = describeWait(entry.blockedUntilUtc - nowUtc);
    const note = `${key} is rate limited; retrying in ${wait}`;
    return entry.snapshot === null
      ? emptyRateLimited(key, nowUtc, note)
      : { ...entry.snapshot, warnings: [...entry.snapshot.warnings, note] };
  }

  const snapshot = await fetchSnapshot();
  if (!snapshot.rateLimited) {
    entry.snapshot = snapshot;
    entry.cachedAtUtc = nowUtc;
    entry.blockedUntilUtc = 0;
    entry.consecutiveRateLimits = 0;
    return snapshot;
  }

  entry.consecutiveRateLimits += 1;
  const backoff = Math.min(
    MAX_BACKOFF_SECONDS,
    BASE_BACKOFF_SECONDS * 2 ** (entry.consecutiveRateLimits - 1),
  );
  const retryAfter = snapshot.retryAfterSeconds;
  const wait = retryAfter !== null && retryAfter > 0 ? Math.max(retryAfter, backoff) : backoff;
  entry.blockedUntilUtc = nowUtc + wait;
  const note = `${key} is rate limited; retrying in ${describeWait(wait)}`;
  // keep the last good numbers on screen rather than replacing them
  return entry.snapshot === null
    ? { ...snapshot, warnings: [note] }
    : { ...entry.snapshot, warnings: [...entry.snapshot.warnings, note] };
}

function emptyRateLimited(key: string, nowUtc: number, note: string): QuotaSnapshot {
  return {
    agent: key,
    account: null,
    plan: null,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    warnings: [note],
    rateLimited: true,
    retryAfterSeconds: null,
  };
}
