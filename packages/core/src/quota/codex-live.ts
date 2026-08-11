/**
 * Live Codex quota from the endpoint the Codex CLI itself uses. The
 * stored access token is read once and sent as a bearer for a single
 * read-only usage query; it is never written, refreshed, or logged, and
 * an expired token simply makes this source unavailable so the caller
 * falls back to the rollout-log snapshot.
 *
 * Response shape (verified against the live endpoint 2026-08-11):
 *   { plan_type,
 *     rate_limit: { primary_window, secondary_window },
 *     additional_rate_limits: [{ limit_name, metered_feature, rate_limit }] }
 * where a window carries { used_percent, limit_window_seconds,
 * reset_at, reset_after_seconds } and `secondary_window` is often null.
 * Parsing is defensive: anything unrecognized yields no windows rather
 * than a wrong reading.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { jwtEmail } from '../accounts/discovery.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot, QuotaWindow } from './providers.ts';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const FETCH_TIMEOUT_MS = 5000;

export function defaultCodexAuthPath(home: string = homedir()): string {
  return join(home, '.codex', 'auth.json');
}

interface CodexAuth {
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly email: string | null;
}

export function readCodexAuth(path: string = defaultCodexAuthPath()): CodexAuth | null {
  let tokens: Record<string, unknown> | null;
  try {
    const parsed = asObject(JSON.parse(readFileSync(path, 'utf8')));
    tokens = parsed === null ? null : asObject(parsed.tokens);
  } catch {
    return null;
  }
  const accessToken = tokens === null ? null : asString(tokens.access_token);
  if (tokens === null || accessToken === null) {
    return null;
  }
  return {
    accessToken,
    accountId: asString(tokens.account_id),
    email: jwtEmail(asString(tokens.id_token)),
  };
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Accepts epoch seconds, epoch milliseconds, or an ISO timestamp. */
function asEpochSeconds(value: unknown): number | null {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) {
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

/** `primary (10080m)` — same id shape the rollout-log reader produces. */
function windowLabel(base: string, seconds: number | null): string {
  return `${base} (${seconds === null ? '?' : Math.round(seconds / 60)}m)`;
}

function parseWindow(value: unknown, base: string, nowUtc: number): QuotaWindow | null {
  const window = asObject(value);
  const usedPercent = window === null ? null : asFiniteNumber(window.used_percent);
  if (window === null || usedPercent === null) {
    return null;
  }
  const relative = asFiniteNumber(window.reset_after_seconds);
  const resetsAtUtc =
    asEpochSeconds(window.reset_at) ??
    asEpochSeconds(window.resets_at) ??
    (relative === null ? null : nowUtc + Math.floor(relative));
  return {
    id: windowLabel(base, asFiniteNumber(window.limit_window_seconds)),
    usedPercent,
    resetsAtUtc,
  };
}

/** A `rate_limit` block holds the primary window and an optional secondary. */
function parseRateLimit(value: unknown, base: string, nowUtc: number): QuotaWindow[] {
  const rateLimit = asObject(value);
  if (rateLimit === null) {
    return [];
  }
  const windows: QuotaWindow[] = [];
  const primary = parseWindow(rateLimit.primary_window, base, nowUtc);
  if (primary !== null) {
    windows.push(primary);
  }
  const secondary = parseWindow(rateLimit.secondary_window, `${base} secondary`, nowUtc);
  if (secondary !== null) {
    windows.push(secondary);
  }
  return windows;
}

export function parseCodexUsageBody(
  body: unknown,
  nowUtc: number = Math.floor(Date.now() / 1000),
): { readonly plan: string | null; readonly windows: readonly QuotaWindow[] } {
  const root = asObject(body);
  const windows = parseRateLimit(root === null ? null : root.rate_limit, 'primary', nowUtc);
  const additional = root === null ? null : root.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const limit = asObject(entry);
      if (limit === null) {
        continue;
      }
      const name = asString(limit.limit_name) ?? asString(limit.metered_feature) ?? 'additional';
      windows.push(...parseRateLimit(limit.rate_limit, name, nowUtc));
    }
  }
  return { plan: root === null ? null : asString(root.plan_type), windows };
}

/**
 * Returns null when the source is unavailable (no credentials) so the
 * caller can fall back silently; a reachable-but-failing endpoint
 * returns a warning-only snapshot instead.
 */
export async function fetchCodexLiveQuota(options: {
  readonly authPath?: string;
  readonly nowUtc?: number;
  readonly fetchFn?: FetchLike;
  readonly url?: string;
}): Promise<QuotaSnapshot | null> {
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const auth = readCodexAuth(options.authPath ?? defaultCodexAuthPath());
  if (auth === null) {
    return null;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
  };
  if (auth.accountId !== null) {
    headers['ChatGPT-Account-Id'] = auth.accountId;
  }
  try {
    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(options.url ?? CODEX_USAGE_URL, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : null;
      return makeQuotaSnapshot({
        agent: 'codex',
        accountId: auth.accountId,
        account: auth.email,
        source: 'vendor_api',
        observedAtUtc: now,
        windows: [],
        failure: {
          kind: 'rate_limited',
          failedAtUtc: now,
          retryAtUtc: retryAfterSeconds === null ? null : now + retryAfterSeconds,
        },
        retryAfterSeconds,
        warnings: ['codex usage endpoint returned 429 (rate limited)'],
      });
    }
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }
    const parsed = parseCodexUsageBody(await response.json(), now);
    if (parsed.windows.length === 0) {
      throw new Error('no rate limit windows in response');
    }
    return makeQuotaSnapshot({
      agent: 'codex',
      accountId: auth.accountId,
      account: auth.email,
      plan: parsed.plan,
      source: 'vendor_api',
      observedAtUtc: now,
      windows: parsed.windows,
    });
  } catch (error) {
    return makeQuotaSnapshot({
      agent: 'codex',
      accountId: auth.accountId,
      account: auth.email,
      source: 'vendor_api',
      observedAtUtc: now,
      windows: [],
      failure: { kind: 'transport', failedAtUtc: now, retryAtUtc: null },
      warnings: [
        `codex live quota fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
  }
}
