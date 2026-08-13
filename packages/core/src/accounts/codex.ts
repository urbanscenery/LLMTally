/**
 * Codex account capture and switching. The Codex CLI keeps its whole
 * login in one file — `~/.codex/auth.json` — so a switch is a swap of
 * that file. Two things make the swap safe:
 *
 *   - Codex documents no lock protocol and refreshes the file itself
 *     (`last_refresh` moves whenever it rotates the access token), so
 *     the write is guarded by a re-read CAS: the file is read once to
 *     classify/back up the outgoing login and read again immediately
 *     before the rename — any change in between aborts the switch
 *     rather than clobbering a rotation that just happened.
 *   - The outgoing login is always preserved first: backed up onto its
 *     vault entry when the refresh-token lineage matches a stored
 *     account, stashed under `unclaimed/` when it matches nobody.
 *
 * Unlike Claude Code there is no config splice: the account identity
 * lives inside auth.json itself, so writing the file IS the switch.
 * Which account is active is derived from the file — no vault marker.
 */
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';
import { writeFilePrivate } from '../fs/atomic.ts';
import { jwtEmail } from './discovery.ts';
import type { AccountVault, VaultEntry } from './vault.ts';

export class CodexAccountError extends Error {
  override readonly name = 'CodexAccountError';
}

export const CODEX_AGENT = 'codex';

export function defaultCodexAuthPath(home: string = homedir()): string {
  return join(home, '.codex', 'auth.json');
}

interface CodexIdentity {
  readonly accountId: string;
  readonly email: string | null;
}

/** The `tokens` block codex writes; every field optional as read. */
export interface CodexTokens {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly accountId: string | null;
}

/** The token block inside auth.json; null when the file is unparseable. */
export function readCodexTokens(text: string): CodexTokens | null {
  let tokens: Record<string, unknown> | null;
  try {
    tokens = asObject(asObject(JSON.parse(text))?.tokens ?? null);
  } catch {
    return null;
  }
  if (tokens === null) {
    return null;
  }
  return {
    accessToken: asString(tokens.access_token),
    refreshToken: asString(tokens.refresh_token),
    idToken: asString(tokens.id_token),
    accountId: asString(tokens.account_id),
  };
}

/** Identity carried inside the auth.json bytes; null when unusable. */
export function readCodexIdentity(text: string): CodexIdentity | null {
  const tokens = readCodexTokens(text);
  if (tokens === null || tokens.accountId === null || tokens.accessToken === null) {
    return null;
  }
  return { accountId: tokens.accountId, email: jwtEmail(tokens.idToken) };
}

/**
 * A rotated generation in codex's own auth.json shape: every field the
 * file already had is preserved and only what the token endpoint
 * actually returned is replaced, so a refreshed file stays something
 * the codex CLI itself can read back. Null when the text is not
 * auth.json or the response carried no access token.
 */
export function withRotatedCodexTokens(
  text: string,
  rotated: {
    readonly accessToken: string | null;
    readonly refreshToken: string | null;
    readonly idToken: string | null;
  },
  nowUtc: number,
): string | null {
  if (rotated.accessToken === null) {
    return null;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asObject(JSON.parse(text));
  } catch {
    return null;
  }
  const tokens = parsed === null ? null : asObject(parsed.tokens);
  if (parsed === null || tokens === null) {
    return null;
  }
  return JSON.stringify({
    ...parsed,
    tokens: {
      ...tokens,
      id_token: rotated.idToken ?? tokens.id_token,
      access_token: rotated.accessToken,
      refresh_token: rotated.refreshToken ?? tokens.refresh_token,
    },
    last_refresh: new Date(nowUtc * 1000).toISOString(),
  });
}

/**
 * Lineage identity for codex credentials: the refresh token survives
 * the frequent access-token rotations, so two generations of the same
 * login compare equal. Content hash when there is no refresh token.
 */
export function codexCredentialFingerprint(text: string): string {
  const refresh = readCodexTokens(text)?.refreshToken ?? null;
  const hash = new Bun.CryptoHasher('sha256')
    .update(refresh ?? text)
    .digest('hex');
  return refresh !== null ? `sha256:${hash}` : `sha256-full:${hash}`;
}

function readAuthFile(authPath: string): string | null {
  try {
    const text = readFileSync(authPath, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** Snapshot of the codex login that is active right now. */
export function captureCodexAccount(ports: {
  readonly vault: AccountVault;
  readonly authPath?: string;
  readonly alias?: string | null;
  readonly nowUtc?: number;
}): VaultEntry {
  const authPath = ports.authPath ?? defaultCodexAuthPath();
  const live = readAuthFile(authPath);
  const identity = live === null ? null : readCodexIdentity(live);
  if (live === null || identity === null) {
    throw new CodexAccountError(
      `no usable Codex login found in ${authPath} — run "codex login" first`,
    );
  }
  const existing = ports.vault.get(CODEX_AGENT, identity.accountId);
  return ports.vault.put(
    {
      agent: CODEX_AGENT,
      accountId: identity.accountId,
      email: identity.email,
      organizationUuid: null,
      organizationName: null,
      alias: ports.alias === undefined ? (existing?.alias ?? null) : ports.alias,
      addedAtUtc: existing?.addedAtUtc ?? ports.nowUtc ?? Math.floor(Date.now() / 1000),
      // a capture is proof of a working login; lift any quarantine
      refreshDeadAtUtc: null,
    },
    live,
  );
}

export interface CodexDetachResult {
  readonly entry: VaultEntry;
  readonly warnings: readonly string[];
}

/**
 * Stores the live codex login and then removes auth.json, leaving codex
 * signed out locally **without revoking anything**.
 *
 * This exists because of how `codex login` treats the file it is about
 * to overwrite: it runs its logout path first, which revokes the
 * refresh token found there — and revoking a refresh token kills the
 * whole family, so the previous account's stored credentials become
 * `token_revoked` the instant a second account signs in. Measured
 * 2026-08-13: with auth.json in place, the previous account answered
 * HTTP 401 `token_revoked`; with auth.json moved aside first, the same
 * stored account still answered 200 after the new login. Nothing is
 * revoked when there is no file to read, so detaching before signing in
 * is what makes two live codex logins possible at all.
 *
 * The order is the safety property: the credentials are captured and
 * verified byte-for-byte against the vault before the only other copy
 * is destroyed. A capture that does not land aborts the detach.
 */
export function detachCodexLogin(ports: {
  readonly vault: AccountVault;
  readonly authPath?: string;
  readonly nowUtc?: number;
}): CodexDetachResult {
  const authPath = ports.authPath ?? defaultCodexAuthPath();
  // throws when there is no usable login — nothing to preserve, and
  // deleting an unreadable file would destroy a login we cannot restore
  const entry = captureCodexAccount({
    vault: ports.vault,
    authPath,
    nowUtc: ports.nowUtc,
  });
  const stored = ports.vault.loadCredentials(CODEX_AGENT, entry.accountId);
  const live = readAuthFile(authPath);
  if (stored === null || live === null || stored !== live) {
    throw new CodexAccountError(
      'refusing to detach: the vault copy does not match the live login — auth.json was left alone',
    );
  }
  // CAS via atomic rename: move the file aside first, then verify the
  // moved bytes. A rotation landing between the compare above and the
  // rename shows up as a mismatch on the staged copy — restore it and
  // abort instead of deleting a login the vault never captured.
  const staged = `${authPath}.llmtally-detach-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  renameSync(authPath, staged);
  if (readAuthFile(staged) !== stored) {
    if (readAuthFile(authPath) === null) {
      // nothing recreated the live path — put the login back
      renameSync(staged, authPath);
      throw new CodexAccountError(
        'refusing to detach: auth.json rotated during the detach — the login was restored, try again',
      );
    }
    // a recreated auth.json is newer truth; keep both, touch neither
    throw new CodexAccountError(
      `refusing to detach: auth.json rotated during the detach — the previous bytes are kept at ${staged}`,
    );
  }
  rmSync(staged, { force: true });
  return {
    entry,
    warnings: [
      'codex is signed out locally, but nothing was revoked',
      `run "codex login" as another account and press n to store it, or press s to bring ${entry.email ?? entry.accountId} back`,
      'a running codex session keeps its old token until restarted',
    ],
  };
}

/** Resolves an id, alias, or email — among codex entries only. */
function resolveCodexEntry(vault: AccountVault, selector: string): VaultEntry {
  const entries = vault.list().filter((entry) => entry.agent === CODEX_AGENT);
  const byId = entries.find((entry) => entry.accountId === selector);
  if (byId !== undefined) {
    return byId;
  }
  const lowered = selector.trim().toLowerCase();
  const byAlias = entries.filter((entry) => entry.alias === lowered);
  if (byAlias.length === 1 && byAlias[0] !== undefined) {
    return byAlias[0];
  }
  const byEmail = entries.filter((entry) => entry.email?.toLowerCase() === lowered);
  if (byEmail.length === 1 && byEmail[0] !== undefined) {
    return byEmail[0];
  }
  if (byEmail.length > 1) {
    throw new CodexAccountError(
      `"${selector}" matches ${byEmail.length} codex accounts — use the account id`,
    );
  }
  throw new CodexAccountError(`no stored codex account matches "${selector}"`);
}

export type CodexOutgoingKind = 'own' | 'unclaimed' | 'absent';

export interface CodexSwitchResult {
  readonly target: VaultEntry;
  readonly outgoing: CodexOutgoingKind;
  readonly stashId: string | null;
  readonly warnings: readonly string[];
}

export async function switchCodexAccount(
  selector: string,
  ports: {
    readonly vault: AccountVault;
    readonly authPath?: string;
    readonly nowUtc?: number;
    /** Test seam: runs between the CAS re-read and the rename. */
    readonly beforeWrite?: () => void;
  },
): Promise<CodexSwitchResult> {
  const authPath = ports.authPath ?? defaultCodexAuthPath();
  const now = ports.nowUtc ?? Math.floor(Date.now() / 1000);
  const { vault } = ports;

  const target = resolveCodexEntry(vault, selector);
  if (target.refreshDeadAtUtc !== null) {
    throw new CodexAccountError(
      `the stored login for ${target.email ?? target.accountId} was rejected — run "codex login" as that account once (llmtally re-captures it on the next add)`,
    );
  }
  const targetCredentials = vault.loadCredentials(CODEX_AGENT, target.accountId);
  if (targetCredentials === null) {
    throw new CodexAccountError(
      `no stored credentials for ${target.email ?? target.accountId} — press n while logged in as that account`,
    );
  }

  const warnings: string[] = [];
  const live = readAuthFile(authPath);
  const liveIdentity = live === null ? null : readCodexIdentity(live);
  if (liveIdentity !== null && liveIdentity.accountId === target.accountId) {
    warnings.push(`${target.email ?? target.accountId} is already the active codex account`);
    return { target, outgoing: 'absent', stashId: null, warnings };
  }

  // preserve the outgoing login before anything is overwritten
  let outgoing: CodexOutgoingKind = 'absent';
  let stashId: string | null = null;
  if (live !== null) {
    const fingerprint = codexCredentialFingerprint(live);
    const owner = vault
      .list()
      .filter((entry) => entry.agent === CODEX_AGENT)
      .find((entry) => {
        // an unreadable third account reads as "no match", not a veto:
        // the outgoing login is still captured/stashed below
        let stored: string | null;
        try {
          stored = vault.loadCredentials(CODEX_AGENT, entry.accountId);
        } catch {
          return false;
        }
        return stored !== null && codexCredentialFingerprint(stored) === fingerprint;
      });
    if (owner !== undefined) {
      outgoing = 'own';
      const { backend: _backend, ...rest } = owner;
      vault.put({ ...rest, refreshDeadAtUtc: null }, live);
    } else if (liveIdentity !== null) {
      // identity readable but lineage unknown: capture it as its own
      // account rather than losing a login the vault simply never saw
      vault.put(
        {
          agent: CODEX_AGENT,
          accountId: liveIdentity.accountId,
          email: liveIdentity.email,
          organizationUuid: null,
          organizationName: null,
          alias: null,
          addedAtUtc: now,
          refreshDeadAtUtc: null,
        },
        live,
      );
      outgoing = 'unclaimed';
      // the entry above preserves it as switchable; the stash keeps the
      // exact bytes as evidence in case the auto-capture ever misfires
      stashId = vault.stashUnclaimed(live, 'codex credentials did not match any stored account', now);
      warnings.push(
        `the live codex login was not stored; captured it as ${liveIdentity.email ?? liveIdentity.accountId} and kept a copy as unclaimed/${stashId}`,
      );
    } else {
      outgoing = 'unclaimed';
      stashId = vault.stashUnclaimed(live, 'unreadable codex credentials before switch', now);
      warnings.push(`the live codex credentials were unreadable; kept a copy as unclaimed/${stashId}`);
    }
  }

  // re-read CAS: abort if codex rotated the file while we were working
  const reread = readAuthFile(authPath);
  if (reread !== live) {
    throw new CodexAccountError(
      'auth.json changed while switching (codex rotated its token) — try again',
    );
  }
  ports.beforeWrite?.();
  const recheck = readAuthFile(authPath);
  if (recheck !== live) {
    throw new CodexAccountError(
      'auth.json changed while switching (codex rotated its token) — try again',
    );
  }

  // atomic activation: full temp write in the same directory + rename
  const staging = join(
    dirname(authPath),
    `.auth.json.llmtally.${process.pid}.${Bun.randomUUIDv7().slice(-8)}`,
  );
  writeFilePrivate(staging, targetCredentials);
  try {
    renameSync(staging, authPath);
  } catch (error) {
    rmSync(staging, { force: true });
    throw new CodexAccountError(
      `could not activate the codex login: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  warnings.push('a running codex session keeps its old token until restarted');
  return { target, outgoing, stashId, warnings };
}
