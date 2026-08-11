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

/** Identity carried inside the auth.json bytes; null when unusable. */
export function readCodexIdentity(text: string): CodexIdentity | null {
  let tokens: Record<string, unknown> | null;
  try {
    tokens = asObject(asObject(JSON.parse(text))?.tokens ?? null);
  } catch {
    return null;
  }
  const accountId = tokens === null ? null : asString(tokens.account_id);
  const accessToken = tokens === null ? null : asString(tokens.access_token);
  if (tokens === null || accountId === null || accessToken === null) {
    return null;
  }
  return { accountId, email: jwtEmail(asString(tokens.id_token)) };
}

/**
 * Lineage identity for codex credentials: the refresh token survives
 * the frequent access-token rotations, so two generations of the same
 * login compare equal. Content hash when there is no refresh token.
 */
export function codexCredentialFingerprint(text: string): string {
  let refresh: string | null = null;
  try {
    const tokens = asObject(asObject(JSON.parse(text))?.tokens ?? null);
    refresh = tokens === null ? null : asString(tokens.refresh_token);
  } catch {
    refresh = null;
  }
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
  const existing = ports.vault.get(identity.accountId);
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
  const targetCredentials = vault.loadCredentials(target.accountId);
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
        const stored = vault.loadCredentials(entry.accountId);
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
