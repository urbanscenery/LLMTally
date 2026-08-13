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

import { readCodexTokens } from '../accounts/codex.ts';
import { jwtEmail } from '../accounts/discovery.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import type { QuotaThrottleSubject } from './fetch-state.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot, QuotaWindow } from './providers.ts';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/**
 * Codex CLI's own GET of this path has no short client timeout. Five
 * seconds is shorter than Cloudflare plus a failed IPv6 attempt on the
 * same host, which is why the TUI reported `The operation timed out`
 * while `codex` itself still worked. Token refresh already budgets 10s.
 */
export const CODEX_USAGE_TIMEOUT_MS = 15_000;

export function defaultCodexAuthPath(home: string = homedir()): string {
  return join(home, '.codex', 'auth.json');
}

export interface CodexAuth {
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly email: string | null;
}

export function readCodexAuth(path: string = defaultCodexAuthPath()): CodexAuth | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const tokens = readCodexTokens(text);
  if (tokens === null || tokens.accessToken === null) {
    return null;
  }
  return {
    accessToken: tokens.accessToken,
    accountId: tokens.accountId,
    email: jwtEmail(tokens.idToken),
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
 * Budget key for one codex account. The account has to be *in* the key:
 * auth.json holds a different login after every switch, and a key that
 * ignored it would serve the previous account's reading for the rest of
 * the cache window — while the account that just became active is
 * skipped everywhere else for being active. The result is an account
 * nothing reads at all.
 */
export function codexQuotaSubject(
  accountId: string | null,
  account: string | null,
): QuotaThrottleSubject {
  return {
    key: `codex|ua=${LLMTALLY_USER_AGENT}|acct=${accountId ?? 'unknown'}`,
    agent: 'codex',
    accountId,
    account,
  };
}

export interface CodexUsageRequest {
  readonly accessToken: string;
  /** Sent as `ChatGPT-Account-Id`; what scopes the reading to an account. */
  readonly accountId: string | null;
  readonly account: string | null;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
  readonly url?: string;
}

/**
 * One usage read for whichever account the token belongs to. Taking the
 * token as an argument is what lets a stored (non-active) account be
 * read through exactly the same request the live path uses — the only
 * difference between them is where the bytes came from.
 */
export async function fetchCodexUsage(request: CodexUsageRequest): Promise<QuotaSnapshot> {
  const now = request.nowUtc;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${request.accessToken}`,
    Accept: 'application/json',
    'User-Agent': LLMTALLY_USER_AGENT,
  };
  if (request.accountId !== null) {
    headers['ChatGPT-Account-Id'] = request.accountId;
  }
  try {
    const fetchFn = request.fetchFn ?? fetch;
    const response = await fetchFn(request.url ?? CODEX_USAGE_URL, {
      headers,
      signal: AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS),
    });
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : null;
      return makeQuotaSnapshot({
        agent: 'codex',
        accountId: request.accountId,
        account: request.account,
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
    // A codex token dies by revocation far more often than by expiry:
    // `codex login` revokes whatever auth.json held before writing the
    // new login (its logout path targets the refresh token, which takes
    // the whole family with it). The `exp` claim keeps saying "valid"
    // for days afterwards, so a rejection here is the only reliable
    // signal — and it must not be reported as a transport hiccup.
    if (response.status === 401 || response.status === 403) {
      let revoked = false;
      try {
        revoked = (await response.text()).toLowerCase().includes('token_revoked');
      } catch {
        // an unreadable body only costs us the more specific wording
      }
      return makeQuotaSnapshot({
        agent: 'codex',
        accountId: request.accountId,
        account: request.account,
        source: 'vendor_api',
        observedAtUtc: now,
        windows: [],
        failure: { kind: 'auth_invalid', failedAtUtc: now, retryAtUtc: null },
        warnings: [
          revoked
            ? 'this codex token was revoked (signing in as another account revokes the previous one) — run "codex login" as this account again'
            : `codex rejected this token (http ${response.status}) — run "codex login" as this account again`,
        ],
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
      accountId: request.accountId,
      account: request.account,
      plan: parsed.plan,
      source: 'vendor_api',
      observedAtUtc: now,
      windows: parsed.windows,
    });
  } catch (error) {
    return makeQuotaSnapshot({
      agent: 'codex',
      accountId: request.accountId,
      account: request.account,
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
  const auth = readCodexAuth(options.authPath ?? defaultCodexAuthPath());
  if (auth === null) {
    return null;
  }
  return fetchCodexUsage({
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    account: auth.email,
    nowUtc: options.nowUtc ?? Math.floor(Date.now() / 1000),
    fetchFn: options.fetchFn,
    url: options.url,
  });
}
