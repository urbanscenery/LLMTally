/**
 * Keeps the vault's copies of the *live* grok logins in step with the
 * bytes the Grok CLI is actually using.
 *
 * The CLI refreshes `auth.json` in place during normal use, and xAI
 * rotates the refresh token on every grant (three distinct values were
 * observed within one login, 2026-08-13). A vault still holding the
 * generation captured at "add" or at the last switch is therefore a
 * consumed predecessor — and the first time llmtally needs it (the
 * account leaves the live file and a quota poll tries to renew it) the
 * token endpoint answers `invalid_grant` and a healthy account is
 * quarantined. Mirroring the live bytes closes that window, exactly as
 * the codex mirror does, and costs no network: every record names its
 * own owner (`user_id`).
 *
 * Unlike codex the file can hold several live logins (one per
 * issuer::client slot); each stored one is mirrored independently.
 */
import { readFileSync } from 'node:fs';

import { credentialFingerprint } from './credentials.ts';
import {
  GROK_AGENT,
  grokEntryFingerprint,
  readGrokAuthEntries,
  readStoredGrokEntry,
  serializeGrokEntry,
} from './grok.ts';
import type { AccountVault } from './vault.ts';

export type GrokLiveSyncOutcome =
  /** No stored slot for any live login, or no drift to mirror. */
  | 'not_needed'
  /** The vault now holds the generation(s) the grok CLI is using. */
  | 'synced'
  /** auth.json is missing, unreadable, or holds no usable login. */
  | 'unavailable'
  /** Another credential operation held the vault lock. */
  | 'busy';

export interface GrokLiveSyncOptions {
  readonly vault: AccountVault;
  readonly authPath: string;
  readonly nowUtc?: number;
}

export function syncActiveGrokCredentials(options: GrokLiveSyncOptions): GrokLiveSyncOutcome {
  let live: string;
  try {
    live = readFileSync(options.authPath, 'utf8');
  } catch {
    return 'unavailable';
  }
  // a half-written auth.json must never overwrite a backup: syncing
  // demands both an account id and an access token per record
  const entries = live.length === 0
    ? []
    : readGrokAuthEntries(live).filter(
        (entry) => entry.accountId !== null && entry.accessToken !== null,
      );
  if (entries.length === 0) {
    return 'unavailable';
  }

  let synced = false;
  let busy = false;
  for (const entry of entries) {
    if (entry.accountId === null) {
      continue;
    }
    // a login the vault never saw is not ours to store — capturing it is
    // "accounts add", an explicit user action, not a background sync
    if (options.vault.get(GROK_AGENT, entry.accountId) === null) {
      continue;
    }
    let stored: string | null;
    try {
      stored = options.vault.loadCredentials(GROK_AGENT, entry.accountId);
    } catch {
      // an unanswerable keychain is "unknown", not "no credentials"
      continue;
    }
    const storedEntry = stored === null ? null : readStoredGrokEntry(stored);
    if (stored === null || storedEntry === null) {
      continue;
    }
    if (grokEntryFingerprint(storedEntry) === grokEntryFingerprint(entry)) {
      continue;
    }

    // CAS on the generation we compared against: a switch or another
    // sync may have written fresher bytes since the read above
    let result;
    try {
      result = options.vault.replaceCredentialsIfFingerprint(
        GROK_AGENT,
        entry.accountId,
        credentialFingerprint(stored),
        serializeGrokEntry(entry),
        // the live login is proof the lineage works; any quarantine is stale
        { clearRefreshDead: true },
      );
    } catch {
      // the vault could not answer mid-CAS; the next poll retries
      continue;
    }
    if (result === 'updated') {
      synced = true;
    } else if (result === 'busy') {
      // 'busy' means the CAS already waited out the vault lock once;
      // queueing more waits behind a contended lock could stall this
      // synchronous, opportunistic pass for minutes — stop here and let
      // the next poll mirror the rest
      busy = true;
      break;
    }
  }
  if (synced) {
    return 'synced';
  }
  return busy ? 'busy' : 'not_needed';
}
