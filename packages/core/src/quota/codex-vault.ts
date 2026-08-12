/**
 * Live Codex quota for the accounts stored in llmtally's own vault —
 * the ones that are not currently written into `~/.codex/auth.json`.
 * Without this a second Codex login has no numbers at all, because the
 * only account reachable through the live path is whichever one
 * `codex login` wrote last.
 *
 * Two properties of Codex credentials shape the whole file:
 *
 *   - The usage endpoint scopes its answer by the `ChatGPT-Account-Id`
 *     header, so a stored account is read with exactly the request the
 *     live path uses — only the bytes come from somewhere else.
 *   - auth.json records no expiry and the refresh response carries no
 *     `expires_in`, so the access token's own `exp` claim is the only
 *     expiry signal there is. It is generous (measured 10 days against
 *     the live endpoint 2026-08-13), which is why most reads here never
 *     touch the token endpoint at all.
 *
 * Renewal follows the same two rules the Claude path learned: every
 * persist is a fingerprint-guarded compare-and-swap so a slow rotation
 * cannot clobber fresher bytes, and only an explicit `invalid_grant` /
 * `invalid_client` from the token endpoint may quarantine a lineage —
 * everything else is transient and simply retried on the next cadence.
 */
import { readCodexTokens, withRotatedCodexTokens } from '../accounts/codex.ts';
import { credentialFingerprint } from '../accounts/credentials.ts';
import { jwtExpiryUtc } from '../accounts/discovery.ts';
import { VaultError } from '../accounts/vault.ts';
import type { AccountVault, VaultEntry } from '../accounts/vault.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import { fetchCodexUsage } from './codex-live.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot } from './providers.ts';

export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/**
 * The public client id the Codex CLI itself presents (its
 * `CODEX_APP_SERVER_LOGIN_CLIENT_ID` default, and the `client_id` claim
 * inside every token it stores). Not a secret — the OAuth grant is
 * authorized by the refresh token, not by this.
 */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Renew this long before `exp` so a read never races the expiry. */
const EXPIRY_BUFFER_SECONDS = 5 * 60;
const REFRESH_TIMEOUT_MS = 10_000;

export const CODEX_AGENT = 'codex';

/**
 * Only the statuses the token endpoint uses to refuse a grant may
 * quarantine a lineage; any other 4xx is far more likely a proxy or WAF
 * than the grant verdict.
 */
function canCarryPermanentRejection(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

export type CodexRefreshResult =
  | { readonly kind: 'refreshed'; readonly credentials: string }
  | { readonly kind: 'permanent'; readonly code: 'invalid_grant' | 'invalid_client' }
  | { readonly kind: 'transient'; readonly message: string };

function classifyRejection(status: number, bodyText: string): CodexRefreshResult {
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

/**
 * Exchanges a refresh token for a fresh generation, written back in
 * codex's own auth.json shape. Mirrors the CLI's own request: a JSON
 * body of `{ client_id, grant_type, refresh_token }` against
 * `auth.openai.com/oauth/token`, answered with three optional fields.
 * Neither the tokens nor the raw body ever reach the caller.
 */
export async function refreshCodexCredentials(
  credentials: string,
  refreshToken: string,
  nowUtc: number,
  fetchFn: FetchLike,
  tokenUrl: string = CODEX_TOKEN_URL,
): Promise<CodexRefreshResult> {
  let response: Response;
  try {
    response = await fetchFn(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'transient', message: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // an unreadable rejection body stays transient
    }
    return classifyRejection(response.status, bodyText);
  }
  let body: Record<string, unknown> | null;
  try {
    body = asObject(await response.json());
  } catch {
    return { kind: 'transient', message: 'token endpoint returned a malformed body' };
  }
  const rotated = withRotatedCodexTokens(
    credentials,
    {
      accessToken: asString(body?.access_token ?? null),
      refreshToken: asString(body?.refresh_token ?? null),
      idToken: asString(body?.id_token ?? null),
    },
    nowUtc,
  );
  if (rotated === null) {
    return { kind: 'transient', message: 'token endpoint response was missing the access token' };
  }
  return { kind: 'refreshed', credentials: rotated };
}

export interface VaultCodexQuotaOptions {
  readonly vault: AccountVault;
  /**
   * The codex login active right now, read from auth.json. It is skipped
   * here: the live path already reads it, and renewing its token behind
   * the running CLI's back would fight with it.
   */
  readonly activeAccountId: string | null;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
  /** false keeps this strictly read-only (no token endpoint calls). */
  readonly allowRefresh?: boolean;
  /** Restrict to one stored account, so each can be throttled separately. */
  readonly only?: string;
  readonly usageUrl?: string;
  readonly tokenUrl?: string;
}

function label(entry: VaultEntry): string {
  return (entry.email ?? entry.accountId) + (entry.alias === null ? '' : ` [${entry.alias}]`);
}

/** Usable when it will still be valid a few minutes from now. */
function isUsable(accessToken: string | null, nowUtc: number): boolean {
  if (accessToken === null) {
    return false;
  }
  const expiry = jwtExpiryUtc(accessToken);
  // a token with no `exp` claim cannot be proven stale; spending it is
  // the cheaper error (one rejected read) versus a needless renewal
  return expiry === null || expiry - EXPIRY_BUFFER_SECONDS > nowUtc;
}

/** One snapshot per stored codex account other than the active one. */
export async function readVaultCodexQuota(
  options: VaultCodexQuotaOptions,
): Promise<readonly QuotaSnapshot[]> {
  const targets = options.vault
    .list()
    .filter(
      (entry) => entry.agent === CODEX_AGENT && entry.accountId !== options.activeAccountId,
    )
    .filter((entry) => options.only === undefined || entry.accountId === options.only);
  const fetchFn = options.fetchFn ?? fetch;

  return Promise.all(
    targets.map(async (entry) => {
      try {
        return await readOneAccount(entry, options, fetchFn);
      } catch (error) {
        // an unanswerable keychain degrades to "unavailable, will retry"
        // instead of killing the poll or posing as missing credentials
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
  options: VaultCodexQuotaOptions,
  fetchFn: FetchLike,
): Promise<QuotaSnapshot> {
  const stored = options.vault.loadCredentials(entry.agent, entry.accountId);
  const tokens = stored === null ? null : readCodexTokens(stored);
  if (stored === null || tokens === null) {
    return unavailable(entry, options.nowUtc, 'no stored credentials to read quota with');
  }

  // a usable access token is spent even under quarantine: the usage
  // endpoint does not care how the token was obtained
  if (isUsable(tokens.accessToken, options.nowUtc)) {
    const snapshot = await usageWith(entry, tokens.accessToken ?? '', options, fetchFn);
    // `exp` said the token was fine and the endpoint disagreed. That is
    // the normal way a codex token dies — revoked, not expired — so the
    // unexpired-token path has to be able to renew too. Without this the
    // account shows a bare 401 forever and never reaches the verdict
    // (`invalid_grant`) that would quarantine it and stop `s` from
    // installing a login that cannot work.
    if (snapshot.failure?.kind !== 'auth_invalid') {
      return snapshot;
    }
    return renew(entry, stored, tokens.refreshToken, options, fetchFn, snapshot);
  }

  if (entry.refreshDeadAtUtc !== null) {
    return unavailable(
      entry,
      options.nowUtc,
      'stored refresh token was rejected; run "codex login" as this account once, then press n to re-capture it',
    );
  }
  if (options.allowRefresh === false || tokens.refreshToken === null) {
    return unavailable(
      entry,
      options.nowUtc,
      'stored token expired; switch to this account (Accounts tab, press s) or re-login',
    );
  }
  return renew(entry, stored, tokens.refreshToken, options, fetchFn, null);
}

/**
 * Renews a stored lineage and reads with the fresh token. `rejected` is
 * the reading that provoked the renewal, if any: when renewal cannot
 * help, that original rejection is what the user needs to see, not a
 * vaguer message about the renewal itself.
 */
async function renew(
  entry: VaultEntry,
  stored: string,
  refreshToken: string | null,
  options: VaultCodexQuotaOptions,
  fetchFn: FetchLike,
  rejected: QuotaSnapshot | null,
): Promise<QuotaSnapshot> {
  if (
    options.allowRefresh === false ||
    refreshToken === null ||
    entry.refreshDeadAtUtc !== null
  ) {
    return (
      rejected ??
      unavailable(
        entry,
        options.nowUtc,
        'stored token expired; switch to this account (Accounts tab, press s) or re-login',
      )
    );
  }

  const expectedFingerprint = credentialFingerprint(stored);
  const refreshed = await refreshCodexCredentials(
    stored,
    refreshToken,
    options.nowUtc,
    fetchFn,
    options.tokenUrl,
  );

  if (refreshed.kind === 'permanent') {
    // quarantine only the generation we judged; if the bytes moved, the
    // verdict is obsolete and the next cycle re-evaluates
    options.vault.markRefreshDeadIfFingerprint(
      entry.agent,
      entry.accountId,
      expectedFingerprint,
      options.nowUtc,
    );
    return unavailable(
      entry,
      options.nowUtc,
      `stored refresh token is dead (${refreshed.code}); run "codex login" as this account again`,
    );
  }
  if (refreshed.kind === 'transient') {
    return unavailable(entry, options.nowUtc, `token renewal failed, will retry: ${refreshed.message}`);
  }

  // OpenAI may rotate the refresh token on a grant, so losing this write
  // would leave the vault holding an invalidated lineage
  const persisted = options.vault.replaceCredentialsIfFingerprint(
    entry.agent,
    entry.accountId,
    expectedFingerprint,
    refreshed.credentials,
    { clearRefreshDead: true },
  );
  if (persisted === 'updated') {
    const rotated = readCodexTokens(refreshed.credentials);
    if (rotated?.accessToken != null) {
      return usageWith(entry, rotated.accessToken, options, fetchFn);
    }
    return unavailable(entry, options.nowUtc, 'renewed credentials carry no access token');
  }
  if (persisted === 'changed' || persisted === 'busy') {
    // someone else rotated or is rotating: use whatever is stored now,
    // but never call the token endpoint twice in one cycle
    const current = options.vault.loadCredentials(entry.agent, entry.accountId);
    const currentTokens = current === null ? null : readCodexTokens(current);
    if (currentTokens !== null && isUsable(currentTokens.accessToken, options.nowUtc)) {
      return usageWith(entry, currentTokens.accessToken ?? '', options, fetchFn);
    }
    return unavailable(entry, options.nowUtc, 'credentials are being rotated; retrying shortly');
  }
  return unavailable(entry, options.nowUtc, 'stored credentials disappeared during renewal');
}

function usageWith(
  entry: VaultEntry,
  accessToken: string,
  options: VaultCodexQuotaOptions,
  fetchFn: FetchLike,
): Promise<QuotaSnapshot> {
  return fetchCodexUsage({
    accessToken,
    accountId: entry.accountId,
    account: label(entry),
    nowUtc: options.nowUtc,
    fetchFn,
    url: options.usageUrl,
  });
}

function unavailable(entry: VaultEntry, nowUtc: number, reason: string): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: CODEX_AGENT,
    accountId: entry.accountId,
    account: label(entry),
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: { kind: 'unavailable', failedAtUtc: nowUtc, retryAtUtc: null },
    warnings: [reason],
  });
}
