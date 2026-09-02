/**
 * Live Grok quota for the accounts stored in llmtally's own vault — the
 * ones not currently written into `~/.grok/auth.json`. Without this a
 * second Grok login has no numbers at all, because the billing route is
 * only reachable with a token, and the live file holds one login per
 * issuer::client slot.
 *
 * This is the one place a grok token may be refreshed. The "never
 * refresh" rule in `quota/grok.ts` protects the LIVE lineage — minting
 * from the live file would rotate it out from under the running CLI.
 * A vault-only lineage has no CLI owner: renewing it fights nobody, and
 * without renewal every stored account dies within ~6 hours (the
 * measured token lifetime). Renewal follows the rules the Claude and
 * codex paths learned: every persist is a fingerprint-guarded
 * compare-and-swap, renewed bytes go to the VAULT ONLY (never back into
 * ~/.grok), and only an explicit `invalid_grant` / `invalid_client`
 * from the token endpoint may quarantine a lineage.
 *
 * The token endpoint comes from `auth.x.ai`'s OIDC discovery document
 * (2026-08-17); the grant is a standard public-client refresh whose
 * `client_id` every stored record already carries.
 */
import { credentialFingerprint } from '../accounts/credentials.ts';
import { GROK_AGENT, readStoredGrokEntry, serializeGrokEntry } from '../accounts/grok.ts';
import type { GrokAuthEntry } from '../accounts/grok.ts';
import { VaultError } from '../accounts/vault.ts';
import type { AccountVault, VaultEntry } from '../accounts/vault.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import { fetchGrokQuota } from './grok.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot } from './providers.ts';

export const GROK_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
/** Renew this long before `expires_at` so a read never races the expiry. */
const EXPIRY_BUFFER_SECONDS = 60;
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Only the statuses the token endpoint uses to refuse a grant may
 * quarantine a lineage; any other 4xx is far more likely a proxy or WAF
 * than the grant verdict.
 */
function canCarryPermanentRejection(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

export type GrokRefreshResult =
  | { readonly kind: 'refreshed'; readonly credentials: string }
  | { readonly kind: 'permanent'; readonly code: 'invalid_grant' | 'invalid_client' }
  | { readonly kind: 'transient'; readonly message: string };

function classifyRejection(status: number, bodyText: string): GrokRefreshResult {
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

/** The client the grant belongs to; the record names it twice. */
function clientIdOf(entry: GrokAuthEntry): string | null {
  const declared = asString(entry.record.oidc_client_id);
  if (declared !== null && declared.length > 0) {
    return declared;
  }
  const separator = entry.entryKey.lastIndexOf('::');
  if (separator === -1) {
    return null;
  }
  const suffix = entry.entryKey.slice(separator + 2);
  return suffix.length > 0 ? suffix : null;
}

/**
 * Exchanges a stored refresh token for a fresh generation, re-assembled
 * as the same single-entry document the vault stores: `key`,
 * `refresh_token` and `expires_at` move, every other field is carried
 * over so a later splice writes back a record the CLI can read.
 * Neither the tokens nor the raw body ever reach the caller.
 */
export async function refreshGrokCredentials(
  stored: GrokAuthEntry,
  nowUtc: number,
  fetchFn: FetchLike,
  tokenUrl: string = GROK_TOKEN_URL,
): Promise<GrokRefreshResult> {
  if (stored.refreshToken === null) {
    return { kind: 'transient', message: 'stored grok credentials carry no refresh token' };
  }
  const clientId = clientIdOf(stored);
  if (clientId === null) {
    return { kind: 'transient', message: 'stored grok credentials carry no client id' };
  }
  let response: Response;
  try {
    response = await fetchFn(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: clientId,
      }).toString(),
      // a 3xx must never carry the refresh token to another host
      redirect: 'error',
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
  const accessToken = body === null ? null : asString(body.access_token);
  if (accessToken === null) {
    return { kind: 'transient', message: 'token endpoint response was missing the access token' };
  }
  const expiresIn = body?.expires_in;
  const { expires_at: _staleExpiry, ...carried } = stored.record;
  const record: Record<string, unknown> = {
    ...carried,
    key: accessToken,
    refresh_token: asString(body?.refresh_token ?? null) ?? stored.refreshToken,
    // no expires_in means an unknown expiry, not the stale one we
    // renewed past — carrying that forward would demand renewal forever
    ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? { expires_at: new Date((nowUtc + expiresIn) * 1000).toISOString() }
      : {}),
  };
  return {
    kind: 'refreshed',
    credentials: serializeGrokEntry({ ...stored, record }),
  };
}

export interface VaultGrokQuotaOptions {
  readonly vault: AccountVault;
  /**
   * The logins live in auth.json right now. They are skipped here: the
   * live path already reads each of them, and renewing a live lineage
   * behind the running CLI's back would rotate it out from under it.
   */
  readonly activeAccountIds: readonly string[];
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
  /** false keeps this strictly read-only (no token endpoint calls). */
  readonly allowRefresh?: boolean;
  /** Restrict to one stored account, so each can be throttled separately. */
  readonly only?: string;
  readonly tokenUrl?: string;
}

function label(entry: VaultEntry): string {
  return (entry.email ?? entry.accountId) + (entry.alias === null ? '' : ` [${entry.alias}]`);
}

/** Usable when it will still be valid a minute from now. */
function isUsable(stored: GrokAuthEntry, nowUtc: number): boolean {
  if (stored.accessToken === null) {
    return false;
  }
  // a record with no expiry cannot be proven stale; spending the token
  // is the cheaper error (one rejected read) versus a needless renewal
  return stored.expiresAtUtc === null || stored.expiresAtUtc - EXPIRY_BUFFER_SECONDS > nowUtc;
}

/** One snapshot per stored grok account other than the live ones. */
export async function readVaultGrokQuota(
  options: VaultGrokQuotaOptions,
): Promise<readonly QuotaSnapshot[]> {
  const active = new Set(options.activeAccountIds);
  const targets = options.vault
    .list()
    .filter((entry) => entry.agent === GROK_AGENT && !active.has(entry.accountId))
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
  options: VaultGrokQuotaOptions,
  fetchFn: FetchLike,
): Promise<QuotaSnapshot> {
  const storedText = options.vault.loadCredentials(entry.agent, entry.accountId);
  const stored = storedText === null ? null : readStoredGrokEntry(storedText);
  if (storedText === null || stored === null) {
    return unavailable(entry, options.nowUtc, 'no stored credentials to read quota with');
  }

  // a usable access token is spent even under quarantine: the billing
  // endpoint does not care how the token was obtained
  if (isUsable(stored, options.nowUtc)) {
    const snapshot = await usageWith(entry, stored, options, fetchFn);
    // `expires_at` said the token was fine and the endpoint disagreed —
    // xAI can revoke ahead of expiry (the server exposes a revocation
    // endpoint), so the unexpired path must be able to renew too, or
    // the account shows a bare 401 forever without ever reaching the
    // verdict that would quarantine it.
    if (snapshot.failure?.kind !== 'auth_invalid') {
      return snapshot;
    }
    return renew(entry, storedText, stored, options, fetchFn, snapshot);
  }
  return renew(entry, storedText, stored, options, fetchFn, null);
}

/**
 * Renews a stored lineage and reads with the fresh token. `rejected` is
 * the reading that provoked the renewal, if any: when renewal cannot
 * help, that original rejection is what the user needs to see.
 */
async function renew(
  entry: VaultEntry,
  storedText: string,
  stored: GrokAuthEntry,
  options: VaultGrokQuotaOptions,
  fetchFn: FetchLike,
  rejected: QuotaSnapshot | null,
): Promise<QuotaSnapshot> {
  if (entry.refreshDeadAtUtc !== null) {
    return (
      rejected ??
      unavailable(
        entry,
        options.nowUtc,
        'stored refresh token was rejected; run "grok" and sign in as this account once, then press n to re-capture it',
      )
    );
  }
  if (options.allowRefresh === false || stored.refreshToken === null) {
    return (
      rejected ??
      unavailable(
        entry,
        options.nowUtc,
        'stored token expired; switch to this account (Accounts tab, press s) or sign in with it again',
      )
    );
  }

  const expectedFingerprint = credentialFingerprint(storedText);
  const refreshed = await refreshGrokCredentials(stored, options.nowUtc, fetchFn, options.tokenUrl);

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
      `stored refresh token is dead (${refreshed.code}); run "grok" and sign in as this account again`,
    );
  }
  if (refreshed.kind === 'transient') {
    return unavailable(entry, options.nowUtc, `token renewal failed, will retry: ${refreshed.message}`);
  }

  // xAI rotates the refresh token on every grant, so losing this write
  // would leave the vault holding an invalidated lineage
  const persisted = options.vault.replaceCredentialsIfFingerprint(
    entry.agent,
    entry.accountId,
    expectedFingerprint,
    refreshed.credentials,
    { clearRefreshDead: true },
  );
  if (persisted === 'updated') {
    const rotated = readStoredGrokEntry(refreshed.credentials);
    if (rotated !== null) {
      return usageWith(entry, rotated, options, fetchFn);
    }
    return unavailable(entry, options.nowUtc, 'renewed credentials carry no access token');
  }
  if (persisted === 'changed' || persisted === 'busy') {
    // someone else rotated or is rotating: use whatever is stored now,
    // but never call the token endpoint twice in one cycle
    const current = options.vault.loadCredentials(entry.agent, entry.accountId);
    const currentEntry = current === null ? null : readStoredGrokEntry(current);
    if (currentEntry !== null && isUsable(currentEntry, options.nowUtc)) {
      return usageWith(entry, currentEntry, options, fetchFn);
    }
    return unavailable(entry, options.nowUtc, 'credentials are being rotated; retrying shortly');
  }
  return unavailable(entry, options.nowUtc, 'stored credentials disappeared during renewal');
}

function usageWith(
  entry: VaultEntry,
  stored: GrokAuthEntry,
  options: VaultGrokQuotaOptions,
  fetchFn: FetchLike,
): Promise<QuotaSnapshot> {
  return fetchGrokQuota({
    credential: {
      accountId: entry.accountId,
      account: label(entry),
      accessToken: stored.accessToken ?? '',
      expiresAtUtc: stored.expiresAtUtc,
    },
    nowUtc: options.nowUtc,
    fetchFn,
  });
}

function unavailable(entry: VaultEntry, nowUtc: number, reason: string): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: GROK_AGENT,
    accountId: entry.accountId,
    account: label(entry),
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: { kind: 'unavailable', failedAtUtc: nowUtc, retryAtUtc: null },
    warnings: [reason],
  });
}
