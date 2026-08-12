/**
 * Keeps the vault's copy of the *active* codex login in step with the
 * bytes the Codex CLI is actually using.
 *
 * Codex refreshes its own auth.json during normal use (`last_refresh`
 * moves whenever it rotates), and nothing tells llmtally: the vault
 * keeps whatever generation it captured at "add" or at the last switch.
 * If OpenAI rotated the refresh token in that grant, the stored copy is
 * a consumed predecessor — and the first time llmtally needs it (the
 * account goes inactive and a quota poll tries to renew it) the token
 * endpoint answers `invalid_grant` and a perfectly healthy account is
 * quarantined. That is the failure the Claude path already had to
 * learn; mirroring the live bytes closes the same window here.
 *
 * Unlike Claude this costs nothing and needs no network: auth.json
 * carries `account_id` in plain sight, so the file names its own owner
 * and no profile probe is needed to attribute the drifted bytes.
 */
import { readFileSync } from 'node:fs';

import { readCodexIdentity } from './codex.ts';
import { credentialFingerprint } from './credentials.ts';
import type { AccountVault } from './vault.ts';

export type CodexLiveSyncOutcome =
  /** No stored slot for the live login, or no drift to mirror. */
  | 'not_needed'
  /** The vault now holds the generation the codex CLI is using. */
  | 'synced'
  /** auth.json is missing, unreadable, or holds no usable login. */
  | 'unavailable'
  /** Another credential operation held the vault lock. */
  | 'busy';

export interface CodexLiveSyncOptions {
  readonly vault: AccountVault;
  readonly authPath: string;
  readonly nowUtc?: number;
}

export function syncActiveCodexCredential(options: CodexLiveSyncOptions): CodexLiveSyncOutcome {
  let live: string;
  try {
    live = readFileSync(options.authPath, 'utf8');
  } catch {
    return 'unavailable';
  }
  // an API-key or half-written auth.json must never overwrite a backup:
  // readCodexIdentity demands both an account id and an access token
  const identity = live.length === 0 ? null : readCodexIdentity(live);
  if (identity === null) {
    return 'unavailable';
  }

  // a login the vault never saw is not ours to store — capturing it is
  // "accounts add", an explicit user action, not a background sync
  const entry = options.vault.get(identity.accountId);
  if (entry === null || entry.agent !== 'codex') {
    return 'not_needed';
  }
  const stored = options.vault.loadCredentials(identity.accountId);
  if (stored === null) {
    return 'unavailable';
  }
  const storedFingerprint = credentialFingerprint(stored);
  if (storedFingerprint === credentialFingerprint(live)) {
    return 'not_needed';
  }

  // CAS on the generation we compared against: a switch or another sync
  // may have written fresher bytes since the read above
  const result = options.vault.replaceCredentialsIfFingerprint(
    identity.accountId,
    storedFingerprint,
    live,
    // the live login is proof the lineage works; any quarantine is stale
    { clearRefreshDead: true },
  );
  if (result === 'updated') {
    return 'synced';
  }
  return result === 'busy' ? 'busy' : 'not_needed';
}
