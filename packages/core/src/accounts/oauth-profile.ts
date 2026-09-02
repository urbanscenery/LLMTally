/**
 * The one question credential bytes cannot answer: *whose* token is this.
 *
 * `~/.claude.json` names the selected account, but the config and the
 * credential store are written separately — a poll landing inside
 * `/login`'s non-atomic write, or a partially synced machine, can leave
 * account B's credentials sitting under a config that still says A. Any
 * code about to copy live credentials into a stored slot has to rule
 * that out first, because the copy would destroy that slot's only
 * surviving refresh token.
 *
 * Strictly advisory and read-only: callers treat null as "unresolvable"
 * and leave the vault alone. Must never be called while a vault or
 * Claude lock is held — network under locks is forbidden.
 */
import { asObject, asString } from '../parsers/shared.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TIMEOUT_MS = 5000;

export type ProfileFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClaudeAccountIdentity {
  readonly accountUuid: string;
  readonly email: string | null;
  readonly organizationUuid: string | null;
}

/**
 * Resolves an access token to its account identity, or null on any
 * failure. A response counts as resolved only when it carries a
 * non-empty `account.uuid`; a schema change that renames it therefore
 * reads as "unresolvable" and keeps callers on their fail-safe path
 * instead of silently comparing against undefined.
 */
export async function fetchClaudeAccountIdentity(
  accessToken: string,
  fetchFn: ProfileFetch = fetch,
): Promise<ClaudeAccountIdentity | null> {
  if (accessToken.length === 0) {
    return null;
  }
  let response: Response;
  try {
    response = await fetchFn(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const account = asObject(asObject(body)?.account ?? null);
  const accountUuid = asString(account?.uuid ?? null)?.trim();
  if (accountUuid === undefined || accountUuid.length === 0) {
    return null;
  }
  const organization = asObject(asObject(body)?.organization ?? null);
  return {
    accountUuid,
    email: asString(account?.email ?? null),
    organizationUuid: asString(organization?.uuid ?? null),
  };
}

/**
 * Whether a paid plan still stands behind the token. `unknown` on any
 * failure, so callers keep their original verdict instead of guessing.
 */
export type ClaudeSubscriptionState = 'paid' | 'free' | 'unknown';

/**
 * The profile endpoint keeps answering 200 after a subscription lapses,
 * which makes it the one place a "free now" verdict can come from — the
 * usage endpoint just refuses free accounts (observed: 429/403, never a
 * body that says why).
 *
 * The discriminator is `organization.organization_type`, NOT the
 * `has_claude_pro`/`has_claude_max` account flags: a Team/Enterprise
 * seat carries both flags as false while the organization is very much
 * paid (observed on a live `claude_team` org). Any non-free type
 * therefore reads as paid; only a schema drift reads as unknown.
 */
export async function fetchClaudeSubscriptionState(
  accessToken: string,
  fetchFn: ProfileFetch = fetch,
): Promise<ClaudeSubscriptionState> {
  if (accessToken.length === 0) {
    return 'unknown';
  }
  let response: Response;
  try {
    response = await fetchFn(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
  } catch {
    return 'unknown';
  }
  if (!response.ok) {
    return 'unknown';
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return 'unknown';
  }
  const organization = asObject(asObject(body)?.organization ?? null);
  const organizationType = asString(organization?.organization_type ?? null)?.trim();
  if (organizationType === undefined || organizationType.length === 0) {
    return 'unknown';
  }
  return organizationType === 'claude_free' ? 'free' : 'paid';
}
