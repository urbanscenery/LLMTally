/**
 * Cursor CLI subscription quota, read with the access token the CLI
 * already keeps in the Keychain (or `~/.cursor/auth.json`).
 *
 * Three allowlisted POSTs on DashboardService — GetPlanInfo,
 * GetCurrentPeriodUsage, GetHardLimit — the same RPCs OpenUsage
 * documents. Undocumented, so missing fields omit a window rather than
 * inventing one. `totalPercentUsed` is never a window: it would sum two
 * pools.
 *
 * Live tokens are never refreshed here. Rotation is unconfirmed; minting
 * from the live slot would fight a running `cursor-agent`. An expired
 * JWT is `unavailable` (last-good stays); `auth_invalid` is only a
 * vendor refusal.
 */
import { CURSOR_CLI_AGENT } from '../parsers/cursor-cli/constants.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import { parseRetryAfterSeconds, readBoundedJson } from './bounded-json.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot, QuotaWindow } from './providers.ts';
import type { QuotaThrottleSubject } from './fetch-state.ts';
import { accessTokenFingerprint } from './throttle.ts';
import type { CursorCliCredentials, CursorCliIdentity } from '../accounts/cursor-cli.ts';

export { CURSOR_CLI_AGENT };

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024;
const EXPIRY_SKEW_SECONDS = 60;
const GONE_TTL_SECONDS = 6 * 3600;
const DEFAULT_ORIGIN = 'https://api2.cursor.sh';

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
export function resetCursorCliQuotaState(): void {
  goneTokens.clear();
}

export function cursorCliQuotaSubject(input: {
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly account: string | null;
}): QuotaThrottleSubject {
  return {
    key: `cursor-cli|ua=${LLMTALLY_USER_AGENT}|token=${accessTokenFingerprint(input.accessToken)}`,
    agent: CURSOR_CLI_AGENT,
    accountId: input.accountId,
    account: input.account,
  };
}

export function isCursorCliTokenExpired(
  credentials: CursorCliCredentials,
  nowUtc: number,
): boolean {
  return (
    credentials.expiresAtUtc !== null &&
    credentials.expiresAtUtc - EXPIRY_SKEW_SECONDS <= nowUtc
  );
}

type RpcResult =
  | { readonly kind: 'ok'; readonly body: Record<string, unknown> }
  | { readonly kind: 'auth_invalid'; readonly warning: string }
  | { readonly kind: 'gone'; readonly warning: string }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'transport'; readonly warning: string };

function rpcUrl(origin: string, method: string): string {
  return `${origin}/aiserver.v1.DashboardService/${method}`;
}

async function postRpc(
  origin: string,
  method: string,
  accessToken: string,
  nowUtc: number,
  fetchFn: FetchLike,
): Promise<RpcResult> {
  const fingerprint = accessTokenFingerprint(accessToken);
  if (isGone(fingerprint, nowUtc)) {
    return {
      kind: 'gone',
      warning: 'cursor-cli: dashboard endpoint is gone; retrying in a few hours',
    };
  }
  let response: Response;
  try {
    response = await fetchFn(rpcUrl(origin, method), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      kind: 'transport',
      warning: `cursor-cli quota fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: parseRetryAfterSeconds(response, nowUtc) };
  }
  if (response.status === 404 || response.status === 410) {
    goneTokens.set(fingerprint, nowUtc);
    return {
      kind: 'gone',
      warning: `cursor-cli: dashboard endpoint is gone (http ${response.status}); retrying in a few hours`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'auth_invalid',
      warning:
        'cursor-cli refused the stored access token; run "cursor agent login" (or "cursor-agent login") to sign in again',
    };
  }
  if (!response.ok) {
    return { kind: 'transport', warning: `cursor-cli quota fetch failed: http ${response.status}` };
  }
  const body = await readBoundedJson(response, MAX_BODY_BYTES);
  if (body === null) {
    return { kind: 'transport', warning: 'cursor-cli returned an unreadable response body' };
  }
  return { kind: 'ok', body };
}

function asPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asCents(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseResetUtc(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() !== '' && Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

function planUsageOf(body: Record<string, unknown>): Record<string, unknown> | null {
  return asObject(body.planUsage) ?? asObject(body.usage) ?? body;
}

/**
 * Windows from GetCurrentPeriodUsage. `totalPercentUsed` is ignored on
 * purpose — it would be a synthetic sum of the two pools.
 */
export function cursorCliWindows(
  usageBody: Record<string, unknown>,
  hardLimitBody: Record<string, unknown> | null = null,
): QuotaWindow[] {
  const usage = planUsageOf(usageBody);
  if (usage === null) {
    return [];
  }
  const resetsAtUtc =
    parseResetUtc(usage.billingCycleEnd) ?? parseResetUtc(usageBody.billingCycleEnd);
  const windows: QuotaWindow[] = [];
  const auto = asPercent(usage.autoPercentUsed);
  if (auto !== null) {
    windows.push({ id: 'cursor_models', usedPercent: auto, resetsAtUtc });
  }
  const other = asPercent(usage.apiPercentUsed);
  if (other !== null) {
    windows.push({ id: 'other_models', usedPercent: other, resetsAtUtc });
  }
  const extra = extraUsageWindow(usage, hardLimitBody, resetsAtUtc);
  if (extra !== null) {
    windows.push(extra);
  }
  return windows;
}

function centsPair(
  used: unknown,
  limit: unknown,
): { readonly used: number; readonly limit: number } | null {
  const usedCents = asCents(used);
  const limitCents = asCents(limit);
  if (usedCents === null || limitCents === null || limitCents <= 0) {
    return null;
  }
  return { used: usedCents, limit: limitCents };
}

function extraUsageWindow(
  usage: Record<string, unknown>,
  hardLimitBody: Record<string, unknown> | null,
  resetsAtUtc: number | null,
): QuotaWindow | null {
  const spend = asObject(usage.spendLimitUsage);
  const hard = hardLimitBody === null ? null : asObject(hardLimitBody.hardLimit) ?? hardLimitBody;
  if (hard !== null && (hard.noUsageBasedAllowed === true || hard.enabled === false)) {
    return null;
  }
  const pair =
    centsPair(spend?.used ?? spend?.current, spend?.limit ?? spend?.cap) ??
    centsPair(usage.onDemandUsed, usage.onDemandLimit) ??
    centsPair(usage.totalSpend, asObject(hard)?.limit ?? usage.limit);
  if (pair === null) {
    return null;
  }
  const usedPercent = Math.min(100, (pair.used / pair.limit) * 100);
  return {
    id: `extra usage $${(pair.used / 100).toFixed(0)}/$${(pair.limit / 100).toFixed(0)}`,
    usedPercent,
    resetsAtUtc,
  };
}

export function cursorCliPlanName(planBody: Record<string, unknown> | null): string | null {
  if (planBody === null) {
    return null;
  }
  const info = asObject(planBody.planInfo) ?? planBody;
  return asString(info.planName) ?? asString(info.name);
}

function redact(warning: string, accessToken: string): string {
  return warning.split(accessToken).join('<redacted>');
}

function failed(
  identity: CursorCliIdentity | null,
  credentials: CursorCliCredentials,
  nowUtc: number,
  kind: 'transport' | 'rate_limited' | 'auth_invalid' | 'unavailable',
  rawWarning: string,
  retryAfterSeconds: number | null = null,
): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: CURSOR_CLI_AGENT,
    accountId: identity?.accountId ?? null,
    account: identity?.email ?? identity?.accountId ?? null,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: {
      kind,
      failedAtUtc: nowUtc,
      retryAtUtc: retryAfterSeconds === null ? null : nowUtc + retryAfterSeconds,
    },
    retryAfterSeconds,
    warnings: [redact(rawWarning, credentials.accessToken)],
  });
}

export interface CursorCliQuotaRequest {
  readonly credentials: CursorCliCredentials;
  readonly identity: CursorCliIdentity | null;
  readonly nowUtc: number;
  readonly origin?: string;
  readonly fetchFn?: FetchLike;
}

export async function fetchCursorCliQuota(request: CursorCliQuotaRequest): Promise<QuotaSnapshot> {
  const { credentials, identity, nowUtc } = request;
  if (isCursorCliTokenExpired(credentials, nowUtc)) {
    return failed(
      identity,
      credentials,
      nowUtc,
      'unavailable',
      'cursor-cli access token expired; run "cursor agent login" (or "cursor-agent login") once — the CLI renews its own token',
    );
  }

  const origin = request.origin ?? DEFAULT_ORIGIN;
  const fetchFn = request.fetchFn ?? fetch;

  const planResult = await postRpc(origin, 'GetPlanInfo', credentials.accessToken, nowUtc, fetchFn);
  if (planResult.kind === 'rate_limited') {
    return failed(
      identity,
      credentials,
      nowUtc,
      'rate_limited',
      'cursor-cli dashboard returned 429 (rate limited)',
      planResult.retryAfterSeconds,
    );
  }
  if (planResult.kind === 'auth_invalid') {
    return failed(identity, credentials, nowUtc, 'auth_invalid', planResult.warning);
  }
  if (planResult.kind === 'gone') {
    return failed(identity, credentials, nowUtc, 'unavailable', planResult.warning);
  }

  const usageResult = await postRpc(
    origin,
    'GetCurrentPeriodUsage',
    credentials.accessToken,
    nowUtc,
    fetchFn,
  );
  if (usageResult.kind === 'rate_limited') {
    return failed(
      identity,
      credentials,
      nowUtc,
      'rate_limited',
      'cursor-cli dashboard returned 429 (rate limited)',
      usageResult.retryAfterSeconds,
    );
  }
  if (usageResult.kind === 'auth_invalid') {
    return failed(identity, credentials, nowUtc, 'auth_invalid', usageResult.warning);
  }
  if (usageResult.kind === 'gone') {
    return failed(identity, credentials, nowUtc, 'unavailable', usageResult.warning);
  }
  if (usageResult.kind === 'transport') {
    return failed(identity, credentials, nowUtc, 'transport', usageResult.warning);
  }

  let hardBody: Record<string, unknown> | null = null;
  const hardResult = await postRpc(origin, 'GetHardLimit', credentials.accessToken, nowUtc, fetchFn);
  if (hardResult.kind === 'ok') {
    hardBody = hardResult.body;
  }

  const windows = cursorCliWindows(usageResult.body, hardBody);
  const warnings: string[] = [];
  if (planResult.kind === 'transport') {
    warnings.push(redact(planResult.warning, credentials.accessToken));
  }
  return makeQuotaSnapshot({
    agent: CURSOR_CLI_AGENT,
    accountId: identity?.accountId ?? null,
    account: identity?.email ?? identity?.accountId ?? null,
    plan: planResult.kind === 'ok' ? cursorCliPlanName(planResult.body) : null,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows,
    warnings,
  });
}

export function cursorCliUnavailableSnapshot(
  identity: CursorCliIdentity | null,
  nowUtc: number,
  warning: string,
): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: CURSOR_CLI_AGENT,
    accountId: identity?.accountId ?? null,
    account: identity?.email ?? identity?.accountId ?? null,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: { kind: 'unavailable', failedAtUtc: nowUtc, retryAtUtc: null },
    warnings: [warning],
  });
}
