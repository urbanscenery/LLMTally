/**
 * Live quota for the Claude accounts stored in llmtally's own vault —
 * the accounts that are not currently logged in. Without this they would
 * have no numbers at all, since only the logged-in account is reachable
 * through the active credential store.
 *
 * The stored access token is short-lived, so an expired one is renewed
 * with its refresh token. Anthropic rotates the refresh token on every
 * grant, which makes persisting the result mandatory rather than
 * optional: dropping the new generation would leave the vault holding a
 * token the server has already invalidated. The write goes to our own
 * vault, never to Claude Code's store.
 */
import { asObject, asString } from '../parsers/shared.ts';
import type { AccountVault, VaultEntry } from '../accounts/vault.ts';
import { fetchClaudeUsage } from './providers.ts';
import type { FetchLike, QuotaSnapshot } from './providers.ts';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

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

/** Returns the refreshed credential text, or null when it cannot be renewed. */
async function refreshCredentials(
  credentials: string,
  refreshToken: string,
  fetchFn: FetchLike,
): Promise<string | null> {
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const body = asObject(await response.json());
  const accessToken = body === null ? null : asString(body.access_token);
  const expiresIn = body?.expires_in;
  if (accessToken === null || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return null;
  }
  const parsed = asObject(JSON.parse(credentials)) ?? {};
  const oauth = asObject(parsed.claudeAiOauth) ?? {};
  return JSON.stringify({
    ...parsed,
    claudeAiOauth: {
      ...oauth,
      accessToken,
      refreshToken: asString(body === null ? null : body.refresh_token) ?? refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    },
  });
}

export interface VaultQuotaOptions {
  readonly vault: AccountVault;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
  /** false keeps this strictly read-only (no token endpoint calls). */
  readonly allowRefresh?: boolean;
  /** Restrict to one stored account, so each can be throttled separately. */
  readonly only?: string;
}

function label(entry: VaultEntry): string {
  return (entry.email ?? entry.accountId) + (entry.alias === null ? '' : ` [${entry.alias}]`);
}

/**
 * One snapshot per stored account other than the active one — the
 * active account is already read through the normal live path, and
 * refreshing its token behind Claude Code's back would fight with it.
 */
export async function readVaultAccountsQuota(
  options: VaultQuotaOptions,
): Promise<readonly QuotaSnapshot[]> {
  const activeAccountId = options.vault.activeAccountId();
  const targets = options.vault
    .list()
    .filter((entry) => entry.agent === 'claude-code' && entry.accountId !== activeAccountId)
    .filter((entry) => options.only === undefined || entry.accountId === options.only);
  const fetchFn = options.fetchFn ?? fetch;

  return Promise.all(
    targets.map(async (entry) => {
      const stored = options.vault.loadCredentials(entry.accountId);
      const oauth = stored === null ? null : readOauth(stored);
      if (stored === null || oauth === null) {
        return unavailable(entry, options.nowUtc, 'no stored credentials to read quota with');
      }
      let credentials = stored;
      let usable = oauth;
      if (!isUsable(usable, options.nowUtc)) {
        if (options.allowRefresh === false || usable.refreshToken === null) {
          return unavailable(entry, options.nowUtc, 'stored token expired; run "llmtally switch" or re-login');
        }
        try {
          const renewed = await refreshCredentials(credentials, usable.refreshToken, fetchFn);
          if (renewed === null) {
            return unavailable(entry, options.nowUtc, 'stored token expired and could not be renewed');
          }
          // the rotated generation is now the only valid one
          options.vault.put({ ...entry }, renewed);
          credentials = renewed;
          usable = readOauth(renewed) ?? usable;
        } catch (error) {
          return unavailable(
            entry,
            options.nowUtc,
            `token renewal failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const accessToken = usable.accessToken;
      if (accessToken === null) {
        return unavailable(entry, options.nowUtc, 'stored credentials have no access token');
      }
      return fetchClaudeUsage({
        accessToken,
        account: label(entry),
        nowUtc: options.nowUtc,
        fetchFn,
      });
    }),
  );
}

function unavailable(entry: VaultEntry, nowUtc: number, reason: string): QuotaSnapshot {
  return {
    agent: 'claude-code',
    account: label(entry),
    plan: null,
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    warnings: [reason],
    rateLimited: false,
    retryAfterSeconds: null,
  };
}
