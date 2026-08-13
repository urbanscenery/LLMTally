/**
 * Grok Build subscription quota, read with the OAuth session token the
 * Grok CLI already keeps in `~/.grok/auth.json`.
 *
 * One allowlisted GET — `/billing?format=credits` on the CLI's own
 * proxy, the route its billing extension calls for `/usage`.
 * Undocumented, like Cline's `usage-limits`, so the parser tolerates
 * missing fields, invents nothing, and a 404/410 stops this process
 * from calling again.
 *
 * Two rules about the token, both load-bearing:
 *
 *   - **Never refresh it.** xAI rotates the refresh token on every
 *     grant (three distinct values observed on one login), so minting
 *     from `auth.json` would rotate the lineage and kill the running
 *     Grok CLI's own session. The CLI refreshes itself; we only read.
 *   - **Never cache it.** The CLI rewrites `auth.json` when it renews,
 *     so a token held from process start goes stale. Every read goes
 *     back to the file.
 *
 * The token lives ~6 hours and is renewed lazily by the CLI, which
 * means a machine that has not run `grok` for a while simply has an
 * expired one. That is a sleeping credential, not a rejected one: the
 * request is skipped locally (no 401 spent proving what the clock
 * already said) and reported as `unavailable`, which keeps the stored
 * last-good numbers on screen. `auth_invalid` is reserved for a token
 * the vendor actually refused, because it discards that history.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { defaultGrokAuthPath } from '../accounts/grok.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { parseRetryAfterSeconds, readBoundedJson } from './bounded-json.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot, QuotaWindow } from './providers.ts';
import type { QuotaThrottleSubject } from './fetch-state.ts';
import { accessTokenFingerprint } from './throttle.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024;
/** Treat a token about to expire as expired; clocks drift, requests take time. */
const EXPIRY_SKEW_SECONDS = 60;
/** A label longer than this is not an email. */
const MAX_LABEL_LENGTH = 256;

export const GROK_AGENT = 'grok';

/**
 * Tokens whose billing route answered 404/410. A gone marker expires
 * after 6 hours: a long-lived sidecar must retry after the vendor
 * recovers, and one transient 410 must not kill the gauge for the
 * whole process lifetime (audit GK-14).
 */
const GONE_TTL_SECONDS = 6 * 3600;
const goneTokens = new Map<string, number>();

function isGone(fingerprint: string, nowUtc: number): boolean {
  const markedAt = goneTokens.get(fingerprint);
  if (markedAt === undefined) {
    return false;
  }
  if (nowUtc - markedAt >= GONE_TTL_SECONDS) {
    goneTokens.delete(fingerprint);
    return false;
  }
  return true;
}

/** Test seam: forgets the auto-disable. */
export function resetGrokQuotaState(): void {
  goneTokens.clear();
}

export interface GrokCredential {
  readonly accountId: string | null;
  /** Display label (email); never the token. */
  readonly account: string | null;
  readonly accessToken: string;
  readonly expiresAtUtc: number | null;
}

export function grokQuotaSubject(input: {
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly account: string | null;
}): QuotaThrottleSubject {
  return {
    key: `grok|ua=${LLMTALLY_USER_AGENT}|token=${accessTokenFingerprint(input.accessToken)}`,
    agent: GROK_AGENT,
    accountId: input.accountId,
    account: input.account,
  };
}

function safeLabel(value: string | null, accessToken: string): string | null {
  if (value === null || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    return null;
  }
  return value.includes(accessToken) ? null : value;
}

/**
 * Every credential entry in `auth.json`, read fresh. A machine signed
 * into two accounts has two entries, each with its own token. Read
 * failures yield an empty list rather than throwing: the CLI holds a
 * lock while it rewrites the file, so a poll can catch a torn read, and
 * the next cadence simply tries again.
 */
export function readGrokCredentials(authPath: string): readonly GrokCredential[] {
  let document: Record<string, unknown> | null;
  try {
    document = asObject(JSON.parse(readFileSync(authPath, 'utf8')));
  } catch {
    return [];
  }
  if (document === null) {
    return [];
  }
  const credentials: GrokCredential[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(document)) {
    const record = asObject(value);
    const accessToken = record === null ? null : asString(record.key);
    if (accessToken === null || accessToken.length === 0 || seen.has(accessToken)) {
      continue;
    }
    seen.add(accessToken);
    credentials.push({
      accountId: asString(record?.user_id ?? null),
      account: safeLabel(asString(record?.email ?? null), accessToken),
      accessToken,
      expiresAtUtc: parseIso(record?.expires_at ?? null),
    });
  }
  return credentials;
}

export function defaultGrokCredentials(home: string = homedir()): readonly GrokCredential[] {
  return readGrokCredentials(defaultGrokAuthPath(home));
}

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function isGrokTokenExpired(credential: GrokCredential, nowUtc: number): boolean {
  return credential.expiresAtUtc !== null && credential.expiresAtUtc - EXPIRY_SKEW_SECONDS <= nowUtc;
}

type GetResult =
  | { readonly kind: 'ok'; readonly body: Record<string, unknown> }
  | { readonly kind: 'auth_invalid'; readonly warning: string }
  | { readonly kind: 'gone'; readonly warning: string }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'transport'; readonly warning: string };

/**
 * The CLI sends impersonation headers (`x-grok-client-identifier`, its
 * own User-Agent); the route answers 200 without them, so llmtally
 * sends its own stable UA instead — the UA is part of the budget
 * identity here, and borrowing another client's would blur it.
 */
async function getBilling(
  accessToken: string,
  nowUtc: number,
  fetchFn: FetchLike,
): Promise<GetResult> {
  const fingerprint = accessTokenFingerprint(accessToken);
  if (isGone(fingerprint, nowUtc)) {
    return { kind: 'gone', warning: 'grok: billing endpoint is gone; retrying in a few hours' };
  }
  let response: Response;
  try {
    response = await fetchFn(BILLING_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      kind: 'transport',
      warning: `grok quota fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: parseRetryAfterSeconds(response, nowUtc) };
  }
  if (response.status === 404 || response.status === 410) {
    goneTokens.set(fingerprint, nowUtc);
    return {
      kind: 'gone',
      warning: `grok: billing endpoint is gone (http ${response.status}); retrying in a few hours`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'auth_invalid',
      warning:
        'grok refused the stored session token; run "grok login" to sign in again',
    };
  }
  if (!response.ok) {
    return { kind: 'transport', warning: `grok quota fetch failed: http ${response.status}` };
  }
  const body = await readBoundedJson(response, MAX_BODY_BYTES);
  if (body === null) {
    return { kind: 'transport', warning: 'grok returned an unreadable response body' };
  }
  return { kind: 'ok', body };
}

/**
 * Vendor period names stay vendor names; the display policy lives in
 * the TUI normalizer. `weekly` and `monthly` already have policy labels
 * there, and an unknown period keeps its own name rather than being
 * mislabelled as one of them.
 */
export function grokPeriodWindowId(type: string | null): string {
  if (type === null || type.length === 0) {
    return 'usage';
  }
  if (type === 'USAGE_PERIOD_TYPE_WEEKLY') {
    return 'weekly';
  }
  if (type === 'USAGE_PERIOD_TYPE_MONTHLY') {
    return 'monthly';
  }
  const suffix = type.replace(/^USAGE_PERIOD_TYPE_/, '').toLowerCase();
  return suffix.length > 0 ? suffix : 'usage';
}

function asPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The subscription is one shared weekly pool, so `creditUsagePercent`
 * is the gauge. `productUsage[]` breaks the same pool down per product
 * and is currently a duplicate of it (single `GrokBuild` entry, equal
 * percent), so a per-product window is emitted only when it actually
 * says something different.
 *
 * `onDemandUsed` / `onDemandCap` / `prepaidBalance` are deliberately
 * left out: every one of them read exactly `0` on the verified account,
 * so whether `val` is cents or dollars is unverified, and a paid-spend
 * gauge off by 100x is worse than no gauge. Add it once an account with
 * non-zero on-demand usage settles the scale.
 */
export function grokWindows(body: Record<string, unknown>): QuotaWindow[] {
  const config = asObject(body.config);
  if (config === null) {
    return [];
  }
  const period = asObject(config.currentPeriod);
  const resetsAtUtc = parseIso(period?.end ?? null);
  const periodId = grokPeriodWindowId(asString(period?.type ?? null));
  const total = asPercent(config.creditUsagePercent);
  const windows: QuotaWindow[] = [];
  if (total !== null) {
    windows.push({ id: periodId, usedPercent: total, resetsAtUtc });
  }
  if (periodId !== 'weekly' || !Array.isArray(config.productUsage)) {
    return windows;
  }
  for (const item of config.productUsage) {
    const entry = asObject(item);
    const product = entry === null ? null : asString(entry.product);
    const percent = asPercent(entry?.usagePercent ?? null);
    if (product === null || product.length === 0 || percent === null || percent === total) {
      continue;
    }
    windows.push({ id: `7d ${product}`, usedPercent: percent, resetsAtUtc });
  }
  return windows;
}

function failed(
  credential: GrokCredential,
  nowUtc: number,
  kind: 'transport' | 'rate_limited' | 'auth_invalid' | 'unavailable',
  rawWarning: string,
  retryAfterSeconds: number | null = null,
): QuotaSnapshot {
  // single exit for failure text: a runtime error quoting the token
  // must never reach history or the screen
  const warning = rawWarning.split(credential.accessToken).join('<redacted>');
  return makeQuotaSnapshot({
    agent: GROK_AGENT,
    accountId: credential.accountId,
    account: credential.account,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: {
      kind,
      failedAtUtc: nowUtc,
      retryAtUtc: retryAfterSeconds === null ? null : nowUtc + retryAfterSeconds,
    },
    retryAfterSeconds,
    warnings: [warning],
  });
}

export interface GrokQuotaRequest {
  readonly credential: GrokCredential;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
}

export async function fetchGrokQuota(request: GrokQuotaRequest): Promise<QuotaSnapshot> {
  const { credential, nowUtc } = request;

  // the clock already answered: spending a request to be told 401 would
  // also record a refusal that discards the stored history
  if (isGrokTokenExpired(credential, nowUtc)) {
    return failed(
      credential,
      nowUtc,
      'unavailable',
      'grok session token expired; run "grok" once — the CLI renews its own token',
    );
  }

  const result = await getBilling(credential.accessToken, nowUtc, request.fetchFn ?? fetch);
  if (result.kind === 'rate_limited') {
    return failed(
      credential,
      nowUtc,
      'rate_limited',
      'grok billing endpoint returned 429 (rate limited)',
      result.retryAfterSeconds,
    );
  }
  if (result.kind === 'auth_invalid') {
    return failed(credential, nowUtc, 'auth_invalid', result.warning);
  }
  if (result.kind === 'gone') {
    return failed(credential, nowUtc, 'unavailable', result.warning);
  }
  if (result.kind === 'transport') {
    return failed(credential, nowUtc, 'transport', result.warning);
  }

  const windows = grokWindows(result.body);
  if (windows.length === 0) {
    return failed(
      credential,
      nowUtc,
      'transport',
      'grok returned an unrecognized billing response (format changed?)',
    );
  }
  return makeQuotaSnapshot({
    agent: GROK_AGENT,
    accountId: credential.accountId,
    account: credential.account,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows,
    warnings: [],
  });
}
