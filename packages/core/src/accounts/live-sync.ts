/**
 * Keeps the vault's copy of the *active* account in step with the
 * credentials Claude Code is actually using.
 *
 * Anthropic rotates the refresh token on every grant and invalidates the
 * predecessor. Claude Code rotates the account it is logged into all day
 * long, and nothing told llmtally: the vault kept whatever generation it
 * captured at "add" or at the last switch. That snapshot is a consumed
 * predecessor within hours, so the first time llmtally needs it — the
 * account goes inactive and a quota poll refreshes it — the token
 * endpoint answers `invalid_grant` and a perfectly healthy account is
 * quarantined. (Measured 2026-08-13: the vault's refresh token was
 * byte-identical to the predecessor a sibling switcher had already
 * consumed.) Mirroring the live bytes closes that window at zero
 * token-endpoint cost, because Claude Code already paid for them.
 *
 * The write is destructive — it replaces a slot's only refresh token —
 * so drifted bytes are attributed before they are trusted. The config
 * naming the slot is not enough: `/login` writes the credential store
 * and `~/.claude.json` separately, so a poll can catch account B's
 * credentials under a config that still says A. The profile oracle
 * settles it, and its verdict is memoized per lineage so a steady state
 * costs nothing.
 */
import { credentialFingerprint, compactJson, hasCompleteOauthTokens, isWipedCredential, oauthAccessToken } from './credentials.ts';
import type { ActiveCredentialStore } from './credentials.ts';
import { fetchClaudeAccountIdentity } from './oauth-profile.ts';
import type { ProfileFetch } from './oauth-profile.ts';
import type { ActiveClaudeContext } from './active-claude.ts';
import type { AccountVault } from './vault.ts';

/** How long an unresolvable probe suppresses re-probing that lineage. */
const PROBE_RETRY_SECONDS = 300;

export type LiveCredentialSyncOutcome =
  /** Nothing to do: no identified login, no stored slot, or no drift. */
  | 'not_needed'
  /** The vault now holds the generation Claude Code is using. */
  | 'synced'
  /** Drift seen but unattributable right now; the vault was left alone. */
  | 'unverified'
  /** The live credentials belong to another account; the vault is safe. */
  | 'foreign'
  /** The live store could not be read, or held nothing usable. */
  | 'unavailable'
  /** Another credential operation held the vault lock. */
  | 'busy';

type ProbeMemo =
  | { readonly kind: 'verdict'; readonly ownsSlot: boolean }
  | { readonly kind: 'inconclusive'; readonly retryAtUtc: number };

const probes = new Map<string, ProbeMemo>();

/** Test seam: drops every memoized ownership verdict. */
export function resetLiveCredentialProbes(): void {
  probes.clear();
}

export interface LiveCredentialSyncOptions {
  readonly context: ActiveClaudeContext;
  readonly vault: AccountVault;
  readonly activeStore: ActiveCredentialStore;
  readonly nowUtc: number;
  readonly fetchFn?: ProfileFetch;
}

export async function syncActiveClaudeCredential(
  options: LiveCredentialSyncOptions,
): Promise<LiveCredentialSyncOutcome> {
  if (options.context.status !== 'identified') {
    return 'not_needed';
  }
  const accountId = options.context.activeAccountId;
  const entry = options.vault.get('claude-code', accountId);
  if (entry === null) {
    return 'not_needed';
  }

  const live = readLive(options.activeStore);
  if (live === null) {
    return 'unavailable';
  }

  let stored: string | null;
  try {
    stored = options.vault.loadCredentials('claude-code', accountId);
  } catch {
    // an unanswerable keychain is "unknown", not "no credentials"
    return 'unavailable';
  }
  if (stored === null) {
    // an entry with no credentials cannot be switched to anyway; seeding
    // it from a live blob is "accounts add", not a background sync
    return 'unavailable';
  }
  const storedFingerprint = credentialFingerprint(stored);
  const liveFingerprint = credentialFingerprint(live);
  if (storedFingerprint === liveFingerprint) {
    return 'not_needed';
  }

  const owns = await verifyLiveCredentialOwner({
    accountId,
    credentials: live,
    nowUtc: options.nowUtc,
    fetchFn: options.fetchFn,
  });
  if (owns === 'unresolved') {
    return 'unverified';
  }
  if (owns === 'foreign') {
    return 'foreign';
  }

  // CAS on the generation we compared against: a switch or another sync
  // landing in the probe's network gap already wrote fresher bytes
  let result;
  try {
    result = options.vault.replaceCredentialsIfFingerprint(
      'claude-code',
      accountId,
      storedFingerprint,
      live,
      // the live login is proof the lineage works; any quarantine is stale
      { clearRefreshDead: true },
    );
  } catch {
    // the vault could not answer mid-CAS; the next poll retries
    return 'unavailable';
  }
  if (result === 'updated') {
    return 'synced';
  }
  return result === 'busy' ? 'busy' : 'not_needed';
}

function readLive(activeStore: ActiveCredentialStore): string | null {
  let live: string | null;
  try {
    live = activeStore.read();
  } catch {
    return null;
  }
  // a half-written or signed-out blob must never overwrite a good backup
  if (live === null || isWipedCredential(live) || !hasCompleteOauthTokens(live)) {
    return null;
  }
  try {
    return compactJson(live);
  } catch {
    return null;
  }
}

/**
 * Whether the credential bytes belong to `accountId`, settled by the
 * profile oracle and memoized per (account, lineage) so a steady state
 * costs nothing. Shared by the mirror above and by quota attribution:
 * a reading taken with these bytes must not be recorded under an
 * account the oracle says they do not belong to.
 */
export async function verifyLiveCredentialOwner(options: {
  readonly accountId: string;
  readonly credentials: string;
  readonly nowUtc: number;
  readonly fetchFn?: ProfileFetch;
}): Promise<'own' | 'foreign' | 'unresolved'> {
  const key = `${options.accountId}|${credentialFingerprint(options.credentials)}`;
  const memo = probes.get(key);
  if (memo?.kind === 'verdict') {
    return memo.ownsSlot ? 'own' : 'foreign';
  }
  if (memo?.kind === 'inconclusive' && options.nowUtc < memo.retryAtUtc) {
    return 'unresolved';
  }

  const accessToken = oauthAccessToken(options.credentials);
  const identity =
    accessToken === null
      ? null
      : await fetchClaudeAccountIdentity(accessToken, options.fetchFn);
  if (identity === null) {
    probes.set(key, {
      kind: 'inconclusive',
      retryAtUtc: options.nowUtc + PROBE_RETRY_SECONDS,
    });
    return 'unresolved';
  }
  const ownsSlot = identity.accountUuid === options.accountId;
  probes.set(key, { kind: 'verdict', ownsSlot });
  return ownsSlot ? 'own' : 'foreign';
}
