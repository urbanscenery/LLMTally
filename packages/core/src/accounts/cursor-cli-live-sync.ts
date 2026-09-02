/**
 * Keeps the vault copy of the live Cursor CLI login in step with the
 * bytes the CLI is actually using, but only along the same lineage:
 * the refresh-token (or access-token) fingerprint must match. A
 * different fingerprint is a different account in the live slot and
 * is left alone — capturing it is an explicit `n`, not a background
 * sync.
 */
import { credentialFingerprint } from './credentials.ts';
import {
  CURSOR_CLI_AGENT,
  credentialsFromVaultDocument,
  cursorCliCredentialFingerprint,
  readCursorCliCredentials,
  readCursorCliIdentity,
  readStoredCursorCliDocument,
  serializeCursorCliVaultDocument,
} from './cursor-cli.ts';
import type { AccountVault } from './vault.ts';
import type { KeychainPort } from './keychain.ts';

export type CursorCliLiveSyncOutcome = 'not_needed' | 'synced' | 'unavailable' | 'busy';

export interface CursorCliLiveSyncOptions {
  readonly vault: AccountVault;
  readonly home: string;
  readonly nowUtc?: number;
  readonly keychain?: KeychainPort;
  readonly fileStore?: boolean;
}

export function syncActiveCursorCliCredentials(
  options: CursorCliLiveSyncOptions,
): CursorCliLiveSyncOutcome {
  const identity = readCursorCliIdentity(options.home);
  if (identity === null) {
    return 'unavailable';
  }
  if (options.vault.get(CURSOR_CLI_AGENT, identity.accountId) === null) {
    return 'not_needed';
  }
  const live = readCursorCliCredentials({
    home: options.home,
    ...(options.keychain === undefined ? {} : { keychain: options.keychain }),
    ...(options.fileStore === undefined ? {} : { fileStore: options.fileStore }),
  });
  if (live.kind === 'error') {
    return 'unavailable';
  }
  if (live.kind === 'absent') {
    return 'unavailable';
  }
  let stored: string | null;
  try {
    stored = options.vault.loadCredentials(CURSOR_CLI_AGENT, identity.accountId);
  } catch {
    return 'unavailable';
  }
  if (stored === null) {
    return 'unavailable';
  }
  const storedDocument = readStoredCursorCliDocument(stored);
  if (storedDocument === null) {
    return 'unavailable';
  }
  const liveFingerprint = cursorCliCredentialFingerprint(live.credentials);
  const storedFingerprint = cursorCliCredentialFingerprint(
    credentialsFromVaultDocument(storedDocument),
  );
  if (liveFingerprint !== storedFingerprint) {
    return 'not_needed';
  }
  const nowUtc = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const next = serializeCursorCliVaultDocument({
    accessToken: live.credentials.accessToken,
    refreshToken: live.credentials.refreshToken,
    apiKey: live.credentials.apiKey,
    authId: identity.authId,
    email: identity.email,
    displayName: identity.displayName,
    userId: identity.accountId,
    capturedAtUtc: nowUtc,
  });
  if (credentialFingerprint(stored) === credentialFingerprint(next)) {
    return 'not_needed';
  }
  let result;
  try {
    result = options.vault.replaceCredentialsIfFingerprint(
      CURSOR_CLI_AGENT,
      identity.accountId,
      credentialFingerprint(stored),
      next,
      { clearRefreshDead: true },
    );
  } catch {
    return 'unavailable';
  }
  if (result === 'updated') {
    return 'synced';
  }
  if (result === 'busy') {
    return 'busy';
  }
  return 'not_needed';
}
