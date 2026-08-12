/**
 * The credential store Claude Code itself reads: the macOS Keychain
 * item `Claude Code-credentials`, or `<config>/.credentials.json` when
 * the Keychain is unavailable. llmtally only writes here while
 * switching accounts (authorized 2026-08-11); every other code path
 * reads.
 *
 * Two rules make switching safe:
 *   - a read that comes back empty is a failure, not "no credentials".
 *     `security` reports a timeout exactly like a missing item, and
 *     treating that as empty would let a switch overwrite a stored
 *     credential with nothing.
 *   - some keys belong to the machine rather than the account. MCP
 *     OAuth grants and plugin secrets stay with whoever is logged in,
 *     so activating a snapshot must not resurrect the stale copies
 *     captured when that account was last active.
 */
import { existsSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject } from '../parsers/shared.ts';
import { writeFilePrivate } from '../fs/atomic.ts';
import { macosKeychain } from './keychain.ts';
import type { KeychainPort } from './keychain.ts';

export const ACTIVE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const FILE_MODE = 0o600;

/** Machine-scoped keys: the live copy always wins, absence included. */
const SHARED_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'mcpOAuth',
  'mcpOAuthClientConfig',
  'mcpXaaIdp',
  'mcpXaaIdpConfig',
  'pluginSecrets',
]);

export class CredentialError extends Error {
  override readonly name = 'CredentialError';
}

export function defaultClaudeConfigHome(home: string = homedir()): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override.startsWith('/') ? override : join(home, '.claude');
}

export interface ActiveCredentialStore {
  /** 'keychain' or 'file' — the backend a write would land in. */
  readonly backend: 'keychain' | 'file';
  /**
   * null means confirmed absent. A keychain that cannot answer (locked,
   * timed out) throws `CredentialError` instead — callers about to
   * overwrite the store must abort on that, not proceed as if empty.
   */
  read(): string | null;
  write(text: string): void;
  /** Removes the stored credentials; used to undo a write that had nothing before it. */
  clear(): void;
  /** Refreshes the credentials file mtime so a running session reloads. */
  touch(): void;
}

export interface ActiveStoreOptions {
  readonly configHome?: string;
  readonly keychain?: KeychainPort;
  readonly keychainAccount?: string;
}

/**
 * Claude Code invalidates its memoized token when `.credentials.json`
 * changes or appears, so a Keychain-only switch bumps the file's mtime
 * when one already exists — but never creates one, which would leave a
 * plaintext copy on a machine that deliberately has none.
 */
export function createActiveCredentialStore(options: ActiveStoreOptions = {}): ActiveCredentialStore {
  const configHome = options.configHome ?? defaultClaudeConfigHome();
  const filePath = join(configHome, '.credentials.json');
  const keychain = options.keychain ?? macosKeychain;
  const account =
    options.keychainAccount ??
    (keychain.available ? (keychain.findAccount(ACTIVE_KEYCHAIN_SERVICE) ?? process.env.USER ?? '') : '');
  const useKeychain = keychain.available;

  return {
    backend: useKeychain ? 'keychain' : 'file',

    read(): string | null {
      if (useKeychain) {
        const result = keychain.read(ACTIVE_KEYCHAIN_SERVICE, account);
        if (result.kind === 'found') {
          return result.value;
        }
        if (result.kind === 'error') {
          throw new CredentialError(
            `could not read the active Claude Code credentials (${result.message}) — refusing to treat them as absent`,
          );
        }
      }
      try {
        const text = readFileSync(filePath, 'utf8');
        return text.length === 0 ? null : text;
      } catch {
        return null;
      }
    },

    write(text: string): void {
      const compact = compactJson(text);
      if (useKeychain) {
        keychain.write(ACTIVE_KEYCHAIN_SERVICE, account, compact);
        this.touch();
        return;
      }
      writeFilePrivate(filePath, compact);
    },

    clear(): void {
      if (useKeychain) {
        keychain.remove(ACTIVE_KEYCHAIN_SERVICE, account);
      }
      rmSync(filePath, { force: true });
    },

    touch(): void {
      if (!existsSync(filePath)) {
        return;
      }
      try {
        const now = new Date();
        utimesSync(filePath, now, now);
      } catch {
        // a failed mtime bump only delays a running session's reload
      }
    },
  };
}

/** Keychain items are single-line, so stored JSON is always compacted. */
export function compactJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CredentialError(
      `credentials are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (asObject(parsed) === null) {
    throw new CredentialError('credentials must be a JSON object');
  }
  return JSON.stringify(parsed);
}

/**
 * True when the OAuth blob has been emptied out. Claude Code writes
 * blank tokens after an `invalid_grant`, and copying that over a stored
 * snapshot would silently destroy a working account.
 */
export function isWipedCredential(text: string): boolean {
  const parsed = asObject(safeParse(text));
  const oauth = parsed === null ? null : asObject(parsed.claudeAiOauth);
  if (oauth === null) {
    return false;
  }
  const access = oauth.accessToken;
  const refresh = oauth.refreshToken;
  return (
    (access === undefined || access === '') && (refresh === undefined || refresh === '')
  );
}

/**
 * True when the OAuth blob carries both halves of a usable grant. A
 * snapshot missing either half is worthless as a backup — restoring it
 * would sign the account out — so it must never overwrite a stored one.
 */
export function hasCompleteOauthTokens(text: string): boolean {
  const parsed = asObject(safeParse(text));
  const oauth = parsed === null ? null : asObject(parsed.claudeAiOauth);
  if (oauth === null) {
    return false;
  }
  return (
    typeof oauth.accessToken === 'string' &&
    oauth.accessToken.length > 0 &&
    typeof oauth.refreshToken === 'string' &&
    oauth.refreshToken.length > 0
  );
}

/** The access token of a stored blob, or null when it carries none. */
export function oauthAccessToken(text: string): string | null {
  const parsed = asObject(safeParse(text));
  const oauth = parsed === null ? null : asObject(parsed.claudeAiOauth);
  const token = oauth === null ? null : oauth.accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Identity of the credential lineage. The refresh token survives access
 * token rotation, so two readings of the same account still match.
 */
export function credentialFingerprint(text: string): string {
  const parsed = asObject(safeParse(text));
  const oauth = parsed === null ? null : asObject(parsed.claudeAiOauth);
  const refresh = oauth === null ? null : oauth.refreshToken;
  if (typeof refresh === 'string' && refresh.length > 0) {
    return `sha256:${hash(refresh)}`;
  }
  return `sha256-full:${hash(text)}`;
}

function hash(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

/**
 * Builds the blob to activate: the target account's own keys, with
 * machine-scoped keys taken from whatever is live right now (including
 * their absence, so a removed MCP grant stays removed).
 */
export function prepareForActivation(targetText: string, liveText: string | null): string {
  const target = asObject(safeParse(targetText));
  if (target === null) {
    throw new CredentialError('stored credentials are not a JSON object');
  }
  const live = liveText === null ? null : asObject(safeParse(liveText));
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) {
    if (!SHARED_CREDENTIAL_KEYS.has(key)) {
      merged[key] = value;
    }
  }
  if (live !== null) {
    for (const key of SHARED_CREDENTIAL_KEYS) {
      if (key in live) {
        merged[key] = live[key];
      }
    }
  }
  return JSON.stringify(merged);
}

export { writeFilePrivate } from '../fs/atomic.ts';
