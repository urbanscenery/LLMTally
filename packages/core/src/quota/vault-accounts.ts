/**
 * Live quota for the Claude accounts stored in llmtally's own vault —
 * the accounts that are not currently logged in. Without this they would
 * have no numbers at all, since only the logged-in account is reachable
 * through the active credential store.
 *
 * The stored access token is short-lived, so an expired one is renewed
 * with its refresh token. Two hard-won rules govern that renewal:
 *
 *   - Anthropic rotates the refresh token on every grant and other
 *     tools (or a later re-capture) may rotate it first, so every
 *     persist is a fingerprint-guarded compare-and-swap — a stale
 *     rotation must never clobber fresher bytes.
 *   - `invalid_grant` means the stored lineage is permanently dead.
 *     Retrying it forever just spends token-endpoint requests, so the
 *     entry is quarantined (`refreshDeadAtUtc`) until fresh credentials
 *     arrive via refresh success, switch, or re-capture. Everything
 *     else (timeouts, 5xx, 429) is transient and simply retried on the
 *     next cadence.
 */
import { asObject, asString } from '../parsers/shared.ts';
import type { ActiveClaudeContext } from '../accounts/active-claude.ts';
import { credentialFingerprint } from '../accounts/credentials.ts';
import { VaultError } from '../accounts/vault.ts';
import type { AccountVault, VaultEntry } from '../accounts/vault.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import { fetchClaudeUsage } from './providers.ts';
import type { FetchLike, QuotaSnapshot } from './providers.ts';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Only the statuses the OAuth token endpoint itself uses to refuse a
 * grant — 400/401/403 — may quarantine a lineage. A 409/418/422 or any
 * other 4xx is almost always a proxy, gateway, or WAF speaking, not the
 * grant verdict; quarantining a live refresh token over a middlebox's
 * odd status is the worse error (the code deliberately errs transient).
 */
function canCarryPermanentRejection(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

interface StoredOauth {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAtMs: number | null;
}

function readOauth(credentials: string): StoredOauth | null {
  let oauth: Record<string, unknown> | null;
  try {
    const parsed = asObject(JSON.parse(credentials));
    oauth = parsed === null ? null : asObject(parsed.claudeAiOauth);
  } catch {
    return null;
  }
  if (oauth === null) {
    return null;
  }
  const expiresAt = oauth.expiresAt;
  return {
    accessToken: asString(oauth.accessToken),
    refreshToken: asString(oauth.refreshToken),
    expiresAtMs: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

function isUsable(oauth: StoredOauth, nowUtc: number): boolean {
  return (
    oauth.accessToken !== null &&
    oauth.expiresAtMs !== null &&
    oauth.expiresAtMs - EXPIRY_BUFFER_MS > nowUtc * 1000
  );
}

export type RefreshCredentialsResult =
  | { readonly kind: 'refreshed'; readonly credentials: string }
  | { readonly kind: 'permanent'; readonly code: 'invalid_grant' | 'invalid_client' }
  | { readonly kind: 'transient'; readonly message: string };

/**
 * Permanent only when the server itself rejected the grant: a 4xx AND
 * an explicit marker in the body (any casing, JSON or plain text).
 * Anything ambiguous stays transient — a misclassified transient costs
 * one retry, a misclassified permanent wrongly quarantines a live
 * token. The raw body and tokens are never surfaced to callers.
 */
function classifyRefreshRejection(
  status: number,
  bodyText: string,
): RefreshCredentialsResult {
  if (canCarryPermanentRejection(status)) {
    const lowered = bodyText.toLowerCase();
    if (lowered.includes('invalid_grant')) {
      return { kind: 'permanent', code: 'invalid_grant' };
    }
    if (lowered.includes('invalid_client')) {
      return { kind: 'permanent', code: 'invalid_client' };
    }
  }
  return { kind: 'transient', message: `token endpoint answered http ${status}` };
}

async function refreshCredentials(
  credentials: string,
  refreshToken: string,
  fetchFn: FetchLike,
): Promise<RefreshCredentialsResult> {
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      kind: 'transient',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // an unreadable rejection body stays transient
    }
    return classifyRefreshRejection(response.status, bodyText);
  }
  let body: Record<string, unknown> | null;
  try {
    body = asObject(await response.json());
  } catch {
    return { kind: 'transient', message: 'token endpoint returned a malformed body' };
  }
  const accessToken = body === null ? null : asString(body.access_token);
  const expiresIn = body?.expires_in;
  if (accessToken === null || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return { kind: 'transient', message: 'token endpoint response was missing the access token' };
  }
  const parsed = asObject(JSON.parse(credentials)) ?? {};
  const oauth = asObject(parsed.claudeAiOauth) ?? {};
  return {
    kind: 'refreshed',
    credentials: JSON.stringify({
      ...parsed,
      claudeAiOauth: {
        ...oauth,
        accessToken,
        refreshToken: asString(body === null ? null : body.refresh_token) ?? refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
      },
    }),
  };
}

export interface VaultQuotaOptions {
  readonly vault: AccountVault;
  /** Resolved once per operation; both active filters use the same one. */
  readonly activeContext: ActiveClaudeContext;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
  /** false keeps this strictly read-only (no token endpoint calls). */
  readonly allowRefresh?: boolean;
  /** Restrict to one stored account, so each can be throttled separately. */
  readonly only?: string;
  /**
   * The refresh token the LIVE credential store currently holds, when
   * readable. A stored slot whose refresh token matches it belongs to a
   * family a running Claude Code session owns — renewing it here would
   * double-rotate that family and invalidate one copy, so the poll
   * defers to the session instead (the mirror re-captures its rotation).
   */
  readonly liveRefreshToken?: () => string | null;
}

function label(entry: VaultEntry): string {
  return (entry.email ?? entry.accountId) + (entry.alias === null ? '' : ` [${entry.alias}]`);
}

/**
 * One snapshot per stored account other than the active one — the
 * active account is already read through the normal live path, and
 * refreshing its token behind Claude Code's back would fight with it.
 * "Active" comes from the resolved context (the live login), never from
 * the registry marker alone.
 */
export async function readVaultAccountsQuota(
  options: VaultQuotaOptions,
): Promise<readonly QuotaSnapshot[]> {
  const activeAccountId = options.activeContext.activeAccountId;
  const targets = options.vault
    .list()
    .filter((entry) => entry.agent === 'claude-code' && entry.accountId !== activeAccountId)
    .filter((entry) => options.only === undefined || entry.accountId === options.only);
  const fetchFn = options.fetchFn ?? fetch;

  return Promise.all(
    targets.map(async (entry) => {
      try {
        return await readOneAccount(entry, options, fetchFn);
      } catch (error) {
        // a keychain that cannot answer right now (locked, timed out)
        // must degrade to "unavailable, will retry" — never kill the
        // whole poll, and never read as "no stored credentials"
        if (error instanceof VaultError) {
          return unavailable(entry, options.nowUtc, `${error.message}; will retry`);
        }
        throw error;
      }
    }),
  );
}

async function readOneAccount(
  entry: VaultEntry,
  options: VaultQuotaOptions,
  fetchFn: FetchLike,
): Promise<QuotaSnapshot> {
  const stored = options.vault.loadCredentials(entry.agent, entry.accountId);
  const oauth = stored === null ? null : readOauth(stored);
  if (stored === null || oauth === null) {
    return unavailable(entry, options.nowUtc, 'no stored credentials to read quota with');
  }

  // a usable access token is spent even under quarantine: the usage
  // endpoint does not care how the token was obtained
  if (isUsable(oauth, options.nowUtc)) {
    return usageWith(entry, oauth.accessToken ?? '', options, fetchFn);
  }

  if (entry.refreshDeadAtUtc !== null) {
    return unavailable(
      entry,
      options.nowUtc,
      'stored refresh token was rejected; run "claude" and /login as this account once — llmtally re-captures it automatically',
    );
  }
  if (options.allowRefresh === false || oauth.refreshToken === null) {
    return unavailable(entry, options.nowUtc, 'stored token expired; switch to this account (Accounts tab, press s) or re-login');
  }
  if (options.liveRefreshToken !== undefined) {
    let liveToken: string | null = null;
    try {
      liveToken = options.liveRefreshToken();
    } catch {
      // an unanswerable live store must not block the renewal path
    }
    if (liveToken !== null && liveToken === oauth.refreshToken) {
      return unavailable(
        entry,
        options.nowUtc,
        'a running Claude Code session holds this token family; deferring renewal to it',
      );
    }
  }

  const expectedFingerprint = credentialFingerprint(stored);
  const refreshed = await refreshCredentials(stored, oauth.refreshToken, fetchFn);

  if (refreshed.kind === 'permanent') {
    // quarantine only the generation we judged; if the bytes moved,
    // the verdict is obsolete and the next cycle re-evaluates
    options.vault.markRefreshDeadIfFingerprint(
      entry.agent,
      entry.accountId,
      expectedFingerprint,
      options.nowUtc,
    );
    return unavailable(
      entry,
      options.nowUtc,
      `stored refresh token is dead (${refreshed.code}); re-login required`,
    );
  }
  if (refreshed.kind === 'transient') {
    return unavailable(
      entry,
      options.nowUtc,
      `token renewal failed, will retry: ${refreshed.message}`,
    );
  }

  // the token endpoint already rotated the lineage: losing this write
  // would leave the vault holding an invalidated refresh token. The
  // CAS itself waits generously on the lock, so a 'busy' here means
  // something held it far beyond any legitimate operation.
  const persisted = options.vault.replaceCredentialsIfFingerprint(
    entry.agent,
    entry.accountId,
    expectedFingerprint,
    refreshed.credentials,
    { clearRefreshDead: true },
  );
  if (persisted === 'updated') {
    const rotated = readOauth(refreshed.credentials);
    if (rotated?.accessToken != null) {
      return usageWith(entry, rotated.accessToken, options, fetchFn);
    }
    return unavailable(entry, options.nowUtc, 'renewed credentials carry no access token');
  }
  if (persisted === 'changed' || persisted === 'busy') {
    // someone else rotated or is rotating: use whatever is stored now,
    // but never call the token endpoint twice in one cycle
    const current = options.vault.loadCredentials(entry.agent, entry.accountId);
    const currentOauth = current === null ? null : readOauth(current);
    if (currentOauth !== null && isUsable(currentOauth, options.nowUtc)) {
      return usageWith(entry, currentOauth.accessToken ?? '', options, fetchFn);
    }
    return unavailable(entry, options.nowUtc, 'credentials are being rotated; retrying shortly');
  }
  return unavailable(entry, options.nowUtc, 'stored credentials disappeared during renewal');
}

function usageWith(
  entry: VaultEntry,
  accessToken: string,
  options: VaultQuotaOptions,
  fetchFn: FetchLike,
): Promise<QuotaSnapshot> {
  return fetchClaudeUsage({
    accessToken,
    accountId: entry.accountId,
    account: label(entry),
    nowUtc: options.nowUtc,
    fetchFn,
  });
}

function unavailable(entry: VaultEntry, nowUtc: number, reason: string): QuotaSnapshot {
  return {
    agent: 'claude-code',
    accountId: entry.accountId,
    account: label(entry),
    plan: null,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    warnings: [reason],
    failure: { kind: 'unavailable', failedAtUtc: nowUtc, retryAtUtc: null },
    rateLimited: false,
    retryAfterSeconds: null,
  };
}
