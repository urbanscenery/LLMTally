/**
 * ClinePass subscription quota, read with the manual `cline-pass` API
 * key OpenCode stores in `auth.json`. No browser cookie, no OAuth
 * session, no token rotation: three allowlisted GETs with the key the
 * user already provisioned for programmatic use.
 *
 * ClinePass is a Cline product, not an OpenCode one, so its reading is
 * its own account row (`agent: 'cline'`) keyed on the Cline user id
 * from `/users/me` — a real vendor subject, unlike the OpenCode bundle
 * fingerprint. That keeps the two subscriptions' freshness, failures,
 * and history independent even though one credential file holds both,
 * and lets a future native-Cline reader merge onto the same row.
 *
 * `/users/me` and `/users/me/plan` are documented; the three-window
 * `usage-limits` route is not — it is what the Cline dashboard itself
 * calls. It was verified working with this key kind on 2026-08-12, but
 * an undocumented route can change or vanish without notice, so the
 * parser tolerates partial data (the live `five_hour` window already
 * omits `resetsAt`), refuses to invent values, and a 404/410 stops this
 * process from calling again.
 */
import { asObject, asString } from '../parsers/shared.ts';
import { parseRetryAfterSeconds, readBoundedJson } from './bounded-json.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot, QuotaWindow } from './providers.ts';
import { accessTokenFingerprint } from './throttle.ts';
import type { QuotaThrottleSubject } from './fetch-state.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';

const API_BASE = 'https://api.cline.bot/api/v1';
const IDENTITY_URL = `${API_BASE}/users/me`;
const PLAN_URL = `${API_BASE}/users/me/plan`;
const USAGE_LIMITS_URL = `${API_BASE}/users/me/plan/usage-limits`;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
/** Identity and plan name change on human timescales, not polling ones. */
const IDENTITY_TTL_SECONDS = 6 * 3600;

export const CLINE_PASS_PROVIDER = 'cline-pass';
export const CLINE_AGENT = 'cline';

/** Vendor window names, in the order they should be read. */
const WINDOW_TYPES = ['five_hour', 'weekly', 'monthly'] as const;
/** An id, email, or plan name past this length is not one. */
const MAX_IDENTITY_FIELD = 256;

/** A display label, or null when it is too long or carries the key. */
function safeLabel(value: string | null, apiKey: string): string | null {
  if (value === null || value.length === 0 || value.length > MAX_IDENTITY_FIELD) {
    return null;
  }
  return value.includes(apiKey) ? null : value;
}

interface ClineIdentity {
  readonly accountId: string;
  readonly account: string | null;
  readonly plan: string | null;
  readonly cachedAtUtc: number;
}

/** Keyed by key fingerprint — never by the key itself. */
const identityCache = new Map<string, ClineIdentity>();

/**
 * Route+credential pairs that answered 404/410. Both halves matter:
 * these are per-account resources, so one credential's 404 says
 * nothing about another's, and scoping by route alone would let a
 * single stale key hide every other Cline account until restart.
 */
const goneEndpoints = new Set<string>();

function goneKey(url: string, apiKey: string): string {
  return `${url}|${accessTokenFingerprint(apiKey)}`;
}

/** Test seam: forgets the identity memo and the auto-disable. */
export function resetClineQuotaState(): void {
  identityCache.clear();
  goneEndpoints.clear();
}

export function clinePassQuotaSubject(input: {
  readonly apiKey: string;
  readonly accountId: string | null;
  readonly account: string | null;
}): QuotaThrottleSubject {
  return {
    key: `cline-pass|ua=${LLMTALLY_USER_AGENT}|key=${accessTokenFingerprint(input.apiKey)}`,
    agent: CLINE_AGENT,
    accountId: input.accountId,
    account: input.account,
  };
}

export interface ClinePassQuotaRequest {
  readonly apiKey: string;
  readonly nowUtc: number;
  /**
   * Where this key was found, used to name a failure that happens
   * before the vendor account is known. It is provenance, not identity:
   * it never becomes an `accountId`, so a failed reading can still be
   * told apart from another one without inventing a Cline account.
   */
  readonly credentialLabel?: string | null;
  readonly fetchFn?: FetchLike;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

type GetResult =
  | { readonly kind: 'ok'; readonly body: Record<string, unknown> }
  | { readonly kind: 'auth_invalid'; readonly warning: string }
  | { readonly kind: 'gone'; readonly warning: string }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'transport'; readonly warning: string };

/** One allowlisted read. The key stays an argument, never a field. */
async function getJson(
  url: string,
  apiKey: string,
  nowUtc: number,
  fetchFn: FetchLike,
): Promise<GetResult> {
  if (goneEndpoints.has(goneKey(url, apiKey))) {
    return { kind: 'gone', warning: 'cline: endpoint is gone; stopped polling until restart' };
  }
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      kind: 'transport',
      warning: `cline quota fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: parseRetryAfterSeconds(response, nowUtc) };
  }
  if (response.status === 404 || response.status === 410) {
    goneEndpoints.add(goneKey(url, apiKey));
    return {
      kind: 'gone',
      warning: `cline: usage endpoint is gone (http ${response.status}); stopped polling until restart`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    // a refused key must not keep naming an account from memory
    identityCache.delete(accessTokenFingerprint(apiKey));
    return {
      kind: 'auth_invalid',
      warning:
        response.status === 401
          ? 'cline rejected the stored cline-pass key'
          : 'cline: the key is valid but is not allowed to read subscription usage',
    };
  }
  if (!response.ok) {
    return { kind: 'transport', warning: `cline quota fetch failed: http ${response.status}` };
  }
  const body = await readBoundedJson(response, MAX_BODY_BYTES);
  if (body === null) {
    return { kind: 'transport', warning: 'cline returned an unreadable response body' };
  }
  return { kind: 'ok', body };
}

function failed(
  identity: ClineIdentity | null,
  nowUtc: number,
  kind: 'transport' | 'rate_limited' | 'auth_invalid' | 'unavailable',
  rawWarning: string,
  retryAfterSeconds: number | null = null,
  apiKey?: string,
  credentialLabel?: string | null,
): QuotaSnapshot {
  // the single exit for failure text: a runtime error that quotes the
  // key must not carry it into history or onto the screen
  const warning = apiKey === undefined ? rawWarning : rawWarning.split(apiKey).join('<redacted>');
  return makeQuotaSnapshot({
    agent: CLINE_AGENT,
    accountId: identity?.accountId ?? null,
    account: identity?.account ?? credentialLabel ?? null,
    plan: identity?.plan ?? null,
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

/** Turns a non-ok read into the matching empty snapshot. */
function failureFor(
  result: Exclude<GetResult, { kind: 'ok' }>,
  identity: ClineIdentity | null,
  nowUtc: number,
  apiKey: string,
  credentialLabel: string | null,
): QuotaSnapshot {
  if (result.kind === 'rate_limited') {
    return failed(
      identity,
      nowUtc,
      'rate_limited',
      'cline usage endpoint returned 429 (rate limited)',
      result.retryAfterSeconds,
      apiKey,
      credentialLabel,
    );
  }
  if (result.kind === 'auth_invalid') {
    return failed(identity, nowUtc, 'auth_invalid', result.warning, null, apiKey, credentialLabel);
  }
  if (result.kind === 'gone') {
    return failed(identity, nowUtc, 'unavailable', result.warning, null, apiKey, credentialLabel);
  }
  return failed(identity, nowUtc, 'transport', result.warning, null, apiKey, credentialLabel);
}

/**
 * Identity names the account row and the history key, so it is fetched
 * before usage and memoized: a reading that cannot say whose it is has
 * nowhere safe to land. The plan label is best-effort — a failure there
 * costs a caption, not the reading.
 */
async function resolveIdentity(
  apiKey: string,
  nowUtc: number,
  fetchFn: FetchLike,
): Promise<ClineIdentity | Exclude<GetResult, { kind: 'ok' }>> {
  const fingerprint = accessTokenFingerprint(apiKey);
  const cached = identityCache.get(fingerprint);
  if (cached !== undefined && nowUtc - cached.cachedAtUtc < IDENTITY_TTL_SECONDS) {
    return cached;
  }
  const [identityResult, planResult] = await Promise.all([
    getJson(IDENTITY_URL, apiKey, nowUtc, fetchFn),
    getJson(PLAN_URL, apiKey, nowUtc, fetchFn),
  ]);
  if (identityResult.kind !== 'ok') {
    return identityResult;
  }
  const data = asObject(identityResult.body.data);
  const accountId = data === null ? null : asString(data.id);
  if (accountId === null || accountId.length === 0 || accountId.length > MAX_IDENTITY_FIELD) {
    return { kind: 'transport', warning: 'cline identity response carried no usable user id' };
  }
  // A success body never passes through the failure redaction, so it
  // needs its own check. The id becomes an account row and a history
  // key: a server echoing the credential there makes the whole reading
  // untrustworthy, not something to sanitise and keep.
  if (accountId.includes(apiKey)) {
    return { kind: 'transport', warning: 'cline identity response was not usable' };
  }
  const planData = planResult.kind === 'ok' ? asObject(planResult.body.data) : null;
  const plan = planData === null ? null : asObject(planData.plan);
  const identity: ClineIdentity = {
    accountId,
    // captions are droppable, so a tainted one is dropped rather than
    // taking the reading down with it
    account: safeLabel(data === null ? null : asString(data.email), apiKey),
    plan: safeLabel(plan === null ? null : asString(plan.displayName), apiKey),
    cachedAtUtc: nowUtc,
  };
  identityCache.set(fingerprint, identity);
  return identity;
}

/** Display email for a ClinePass key; null when identity cannot be read. */
export async function lookupClinePassEmail(input: {
  readonly apiKey: string;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
}): Promise<string | null> {
  const identity = await resolveIdentity(input.apiKey, input.nowUtc, input.fetchFn ?? fetch);
  if ('kind' in identity) {
    return null;
  }
  const email = identity.account;
  return email !== null && email.includes('@') ? email : null;
}

export async function fetchClinePassQuota(
  request: ClinePassQuotaRequest,
): Promise<QuotaSnapshot> {
  const { nowUtc } = request;
  const fetchFn = request.fetchFn ?? fetch;
  const label = request.credentialLabel ?? null;
  const identity = await resolveIdentity(request.apiKey, nowUtc, fetchFn);
  if ('kind' in identity) {
    return failureFor(identity, null, nowUtc, request.apiKey, label);
  }

  const usage = await getJson(USAGE_LIMITS_URL, request.apiKey, nowUtc, fetchFn);
  if (usage.kind !== 'ok') {
    return failureFor(usage, identity, nowUtc, request.apiKey, label);
  }

  const data = asObject(usage.body.data);
  const limits = data === null ? null : data.limits;
  if (!Array.isArray(limits)) {
    return failed(
      identity,
      nowUtc,
      'transport',
      'cline returned an unrecognized usage-limits response (format changed?)',
      null,
      request.apiKey,
      label,
    );
  }

  const byType = new Map<string, Record<string, unknown>>();
  for (const entry of limits) {
    const limit = asObject(entry);
    if (limit === null) {
      continue;
    }
    const type = asString(limit.type);
    if (type !== null) {
      byType.set(type, limit);
    }
  }

  const windows: QuotaWindow[] = [];
  for (const type of WINDOW_TYPES) {
    const limit = byType.get(type);
    if (limit === undefined) {
      continue;
    }
    const percent = limit.percentUsed;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
      // a window without a reading is missing, never zero
      continue;
    }
    // the live five_hour window ships without a reset; that is a
    // missing timestamp, not a missing window
    windows.push({ id: type, usedPercent: percent, resetsAtUtc: parseIso(limit.resetsAt) });
  }
  if (windows.length === 0) {
    return failed(
      identity,
      nowUtc,
      'transport',
      'cline reported no usable usage windows (format changed?)',
      null,
      request.apiKey,
      label,
    );
  }

  const warnings =
    windows.length < WINDOW_TYPES.length
      ? [`cline reported ${windows.length} of ${WINDOW_TYPES.length} usage windows`]
      : [];
  return makeQuotaSnapshot({
    agent: CLINE_AGENT,
    accountId: identity.accountId,
    account: identity.account,
    plan: identity.plan,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows,
    warnings,
  });
}
