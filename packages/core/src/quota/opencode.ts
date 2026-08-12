/**
 * OpenCode Go subscription quota. The vendor runs a first-party hosted
 * read — `GET /zen/go/v1/usage` with the same `opencode-go` API key
 * OpenCode itself stores in `auth.json` — so no session, cookie, or
 * token rotation is involved: one allowlisted GET, key in memory only.
 *
 * The endpoint reports provider-computed percentages, never raw dollars
 * or request counts, and carries no vendor account id. So a reading is
 * bound to the local credential that produced it (the OpenCode bundle
 * account) and two different keys are never merged into one subject.
 *
 * The route shipped 2026-08-11 with no prose docs, OpenAPI, or polling
 * guidance, and its response shape was already reworked once within the
 * hour. Everything here is therefore defensive: unknown fields are
 * ignored, each window decodes independently, a missing percentage
 * drops that window rather than becoming a zero, and a 404/410 stops
 * this process from calling again instead of retrying a dead route
 * every cycle.
 */
import { OPENCODE_AGENT } from '../accounts/opencode.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { parseRetryAfterSeconds, readBoundedJson } from './bounded-json.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot, QuotaWindow } from './providers.ts';
import { accessTokenFingerprint } from './throttle.ts';
import type { QuotaThrottleSubject } from './fetch-state.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const FETCH_TIMEOUT_MS = 5000;
/** A usage payload is a few hundred bytes; anything larger is not ours. */
const MAX_BODY_BYTES = 64 * 1024;

export const OPENCODE_GO_PROVIDER = 'opencode-go';

/** Vendor window names, in the order they should be read. */
const WINDOW_IDS = ['rolling', 'weekly', 'monthly'] as const;

/**
 * Route+credential pairs this process has seen answer 404/410. An
 * endpoint that disappears must not be polled every cycle for the rest
 * of the session; a restart re-checks it once, so a withdrawal that
 * turns out to be temporary heals on its own.
 *
 * The credential is part of the key on purpose. A 404 answered for one
 * key is not evidence about anybody else's — scoping it to the route
 * alone would let a single stale credential hide every other account
 * until the process restarted.
 */
const goneEndpoints = new Set<string>();

function goneKey(url: string, apiKey: string): string {
  return `${url}|${accessTokenFingerprint(apiKey)}`;
}

/** Test seam: forgets the auto-disable so a case can exercise it fresh. */
export function resetOpencodeEndpointState(): void {
  goneEndpoints.clear();
}

/**
 * Budget identity: the key, never the bundle it came from. Two OpenCode
 * credential sets that carry the same Go key are one subscription and
 * must share one budget; rotating the key starts a fresh one.
 */
export function opencodeGoQuotaSubject(input: {
  readonly apiKey: string;
  readonly accountId: string | null;
  readonly account: string | null;
}): QuotaThrottleSubject {
  return {
    key: `opencode-go|ua=${LLMTALLY_USER_AGENT}|key=${accessTokenFingerprint(input.apiKey)}`,
    agent: OPENCODE_AGENT,
    accountId: input.accountId,
    account: input.account,
  };
}

export interface OpencodeGoQuotaRequest {
  readonly apiKey: string;
  /** The OpenCode bundle this key was read from; the display binding. */
  readonly accountId: string | null;
  readonly account: string | null;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function failed(
  request: OpencodeGoQuotaRequest,
  kind: 'unavailable' | 'transport' | 'rate_limited' | 'auth_invalid',
  rawWarning: string,
  retryAfterSeconds: number | null = null,
): QuotaSnapshot {
  const { nowUtc } = request;
  // every failure warning leaves through here, so this is the one place
  // that has to hold the line: neither a vendor echoing the key back nor
  // a runtime error quoting it can put it into history or the screen
  const warning = rawWarning.split(request.apiKey).join('<redacted>');
  return makeQuotaSnapshot({
    agent: OPENCODE_AGENT,
    accountId: request.accountId,
    account: request.account,
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

/**
 * The vendor's 401 wording, but only when it is one we already know.
 * Free-text from a remote server is not something to relay into a
 * warning that gets stored and rendered — an allowlist keeps the useful
 * distinction (no header at all vs. a key that was refused) without
 * ever repeating what the server chose to say.
 */
const KNOWN_AUTH_MESSAGES: ReadonlySet<string> = new Set(['Missing API key.', 'Unauthorized']);

function knownVendorMessage(body: Record<string, unknown> | null): string | null {
  const error = body === null ? null : asObject(body.error);
  const message = error === null ? null : asString(error.message);
  return message !== null && KNOWN_AUTH_MESSAGES.has(message) ? message : null;
}

export async function fetchOpencodeGoQuota(
  request: OpencodeGoQuotaRequest,
): Promise<QuotaSnapshot> {
  if (goneEndpoints.has(goneKey(USAGE_URL, request.apiKey))) {
    return failed(
      request,
      'unavailable',
      'opencode go: usage endpoint no longer exists; stopped polling until restart',
    );
  }
  let response: Response;
  try {
    const fetchFn = request.fetchFn ?? fetch;
    response = await fetchFn(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        Accept: 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // the key must never reach a message, so only the error text is used
    return failed(
      request,
      'transport',
      `opencode go quota fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(response, request.nowUtc);
    return failed(
      request,
      'rate_limited',
      'opencode go usage endpoint returned 429 (rate limited)',
      retryAfterSeconds,
    );
  }
  if (response.status === 404 || response.status === 410) {
    goneEndpoints.add(goneKey(USAGE_URL, request.apiKey));
    return failed(
      request,
      'unavailable',
      `opencode go: usage endpoint is gone (http ${response.status}); stopped polling until restart`,
    );
  }
  if (response.status === 401) {
    const detail = knownVendorMessage(await readBoundedJson(response, MAX_BODY_BYTES)) ?? 'unauthorized';
    return failed(request, 'auth_invalid', `opencode go rejected the stored key: ${detail}`);
  }
  if (response.status === 403) {
    return failed(
      request,
      'auth_invalid',
      'opencode go: the key is valid but has no active Go subscription',
    );
  }
  if (!response.ok) {
    return failed(request, 'transport', `opencode go quota fetch failed: http ${response.status}`);
  }

  const body = await readBoundedJson(response, MAX_BODY_BYTES);
  const usage = body === null ? null : asObject(body.usage);
  if (usage === null) {
    return failed(
      request,
      'transport',
      'opencode go returned an unrecognized usage response (format changed?)',
    );
  }

  const windows: QuotaWindow[] = [];
  const warnings: string[] = [];
  for (const id of WINDOW_IDS) {
    const window = asObject(usage[id]);
    if (window === null) {
      continue;
    }
    const percent = window.percent;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
      // a window without a reading is missing, never zero
      continue;
    }
    windows.push({ id, usedPercent: percent, resetsAtUtc: parseIso(window.resetsAt) });
    if (asString(window.status) === 'rate-limited') {
      // the provider's own exhaustion verdict — not our polling 429
      warnings.push(`opencode go: the ${id} window is used up (provider-reported)`);
    }
  }
  if (windows.length === 0) {
    return failed(
      request,
      'transport',
      'opencode go reported no usable usage windows (format changed?)',
    );
  }
  if (windows.length < WINDOW_IDS.length) {
    warnings.push(
      `opencode go reported ${windows.length} of ${WINDOW_IDS.length} usage windows`,
    );
  }

  return makeQuotaSnapshot({
    agent: OPENCODE_AGENT,
    accountId: request.accountId,
    account: request.account,
    plan: 'Go',
    source: 'vendor_api',
    observedAtUtc: request.nowUtc,
    windows,
    warnings,
  });
}
