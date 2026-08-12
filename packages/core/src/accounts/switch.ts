/**
 * Account switching. This is the only place llmtally writes to Claude
 * Code's own stores, and it is built to fail closed:
 *
 *   1. the outgoing credentials are classified before anything is
 *      overwritten. `~/.claude.json` says which account is *selected*,
 *      not who owns the bytes in the credential store, so bytes that
 *      cannot be attributed are stashed rather than written over
 *      somebody's backup;
 *   2. an empty read aborts the switch — `security` reports a timeout
 *      the same way it reports a missing item;
 *   3. `~/.claude.json` is spliced, not rewritten: only `oauthAccount`
 *      changes, so projects, settings, and history survive;
 *   4. every completed step is undone in reverse if a later one fails.
 *
 * Claude Code's locks are held across the whole critical section and no
 * network call happens inside it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject } from '../parsers/shared.ts';
import { readClaudeActiveIdentity } from './claude.ts';
import { acquireClaudeLocks } from './claude-locks.ts';
import type { LockHandle } from './claude-locks.ts';
import {
  CredentialError,
  compactJson,
  credentialFingerprint,
  defaultClaudeConfigHome,
  isWipedCredential,
  prepareForActivation,
  writeFilePrivate,
} from './credentials.ts';
import type { ActiveCredentialStore } from './credentials.ts';
import type { AccountVault, VaultEntry } from './vault.ts';

export class SwitchError extends Error {
  override readonly name = 'SwitchError';
}

/** What the live credential bytes turned out to be. */
export type OutgoingKind = 'own' | 'wiped' | 'unclaimed' | 'absent';

export interface SwitchResult {
  readonly target: VaultEntry;
  readonly previousAccountId: string | null;
  readonly outgoing: OutgoingKind;
  readonly stashId: string | null;
  readonly backend: 'keychain' | 'file';
  readonly liveSessions: readonly number[];
  readonly warnings: readonly string[];
}

export interface SwitchPorts {
  readonly vault: AccountVault;
  readonly activeStore: ActiveCredentialStore;
  readonly home?: string;
  readonly configHome?: string;
  readonly nowUtc?: number;
  readonly lockTimeoutMs?: number;
  /** Injected in tests; production acquires the real Claude Code locks. */
  readonly acquireLocks?: () => Promise<LockHandle>;
}

function globalConfigPath(home: string): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  const base = override !== undefined && override.startsWith('/') ? override : home;
  return join(base, '.claude.json');
}

/**
 * PIDs of running Claude Code sessions, from the lock files the IDE
 * extension and the CLI leave behind. Used to warn, not to block: a
 * switch is still valid, the session just keeps its old token briefly.
 */
export function liveSessionPids(configHome: string): number[] {
  const pids = new Set<number>();
  for (const [dir, key] of [
    ['ide', 'pid'],
    ['sessions', 'pid'],
  ] as const) {
    let entries: string[];
    try {
      entries = readdirSync(join(configHome, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const parsed = asObject(JSON.parse(readFileSync(join(configHome, dir, entry), 'utf8')));
        const pid = parsed === null ? null : parsed[key];
        if (typeof pid === 'number' && Number.isInteger(pid) && isAlive(pid)) {
          pids.add(pid);
        }
      } catch {
        // stale or unreadable lock file
      }
    }
  }
  return [...pids];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces only the `oauthAccount` section of the global config and
 * returns the previous file text so a failure can restore it verbatim.
 */
function spliceOauthAccount(path: string, entry: VaultEntry): string {
  let original: string;
  try {
    original = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SwitchError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch (error) {
    throw new SwitchError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = asObject(parsed);
  if (config === null) {
    throw new SwitchError(`${path} is not a JSON object`);
  }
  const previousOauth = asObject(config.oauthAccount) ?? {};
  const oauthAccount: Record<string, unknown> = {
    ...previousOauth,
    accountUuid: entry.accountId,
    emailAddress: entry.email ?? '',
    organizationUuid: entry.organizationUuid ?? '',
    organizationName: entry.organizationName ?? '',
  };
  writeFilePrivate(path, `${JSON.stringify({ ...config, oauthAccount }, null, 2)}\n`);
  return original;
}

/** Which stored account, if any, owns the credentials that are live now. */
function classifyOutgoing(
  live: string | null,
  vault: AccountVault,
  home: string,
): { readonly kind: OutgoingKind; readonly owner: VaultEntry | null } {
  if (live === null) {
    return { kind: 'absent', owner: null };
  }
  if (isWipedCredential(live)) {
    return { kind: 'wiped', owner: null };
  }
  const fingerprint = credentialFingerprint(live);
  const byFingerprint = vault
    .list()
    .find((entry) => {
      const stored = vault.loadCredentials(entry.accountId);
      return stored !== null && credentialFingerprint(stored) === fingerprint;
    });
  if (byFingerprint !== undefined) {
    return { kind: 'own', owner: byFingerprint };
  }
  // the lineage is unknown; fall back to whoever the config says is
  // selected, which is right whenever the token merely rotated
  const identity = readClaudeActiveIdentity(globalConfigPath(home));
  const selected = identity?.accountUuid === undefined ? null : vault.get(identity.accountUuid ?? '');
  if (selected !== null) {
    return { kind: 'own', owner: selected };
  }
  return { kind: 'unclaimed', owner: null };
}

export async function switchAccount(selector: string, ports: SwitchPorts): Promise<SwitchResult> {
  const home = ports.home ?? homedir();
  const configHome = ports.configHome ?? defaultClaudeConfigHome(home);
  const now = ports.nowUtc ?? Math.floor(Date.now() / 1000);
  const { vault, activeStore } = ports;

  const target = vault.resolve(selector);
  if (target.refreshDeadAtUtc !== null) {
    // installing a lineage the token endpoint already rejected would
    // just move the dead credentials into Claude Code
    throw new SwitchError(
      `the stored refresh token for ${target.email ?? target.accountId} was rejected — run "claude" and /login as that account once (llmtally re-captures it automatically)`,
    );
  }
  const targetCredentials = vault.loadCredentials(target.accountId);
  if (targetCredentials === null) {
    throw new SwitchError(
      `no stored credentials for ${target.email ?? target.accountId} — open the Accounts tab and press n while logged in as that account`,
    );
  }

  const warnings: string[] = [];
  const liveSessions = liveSessionPids(configHome);
  if (vault.activeAccountId() === target.accountId) {
    warnings.push(`${target.email ?? target.accountId} was already the active account`);
  }

  const locks = await (ports.acquireLocks ?? ((): Promise<LockHandle> =>
    acquireClaudeLocks({ home, configHome, timeoutMs: ports.lockTimeoutMs })))();

  const undo: (() => void)[] = [];
  try {
    const live = activeStore.read();
    const outgoing = classifyOutgoing(live, vault, home);

    let stashId: string | null = null;
    if (outgoing.kind === 'own' && outgoing.owner !== null && live !== null) {
      // refuse to write an unreadable/empty blob over a good backup
      const compact = compactJson(live);
      const owner = outgoing.owner;
      vault.put(
        {
          agent: owner.agent,
          accountId: owner.accountId,
          email: owner.email,
          organizationUuid: owner.organizationUuid,
          organizationName: owner.organizationName,
          alias: owner.alias,
          addedAtUtc: owner.addedAtUtc,
          // live credentials were just working — any quarantine is stale
          refreshDeadAtUtc: null,
        },
        compact,
      );
    } else if (outgoing.kind === 'unclaimed' && live !== null) {
      stashId = vault.stashUnclaimed(live, 'credentials did not match any stored account', now);
      warnings.push(
        `the credentials that were live did not match any stored account; kept a copy as unclaimed/${stashId}`,
      );
    } else if (outgoing.kind === 'wiped') {
      warnings.push('the live credentials were blank (a signed-out session); nothing was backed up');
    }

    const activated = prepareForActivation(targetCredentials, live);
    activeStore.write(activated);
    undo.push(() => {
      // clearing matters: if there were no credentials before, leaving
      // the target's behind would make a later "accounts add" attribute
      // them to whichever account the config still names
      if (live === null) {
        activeStore.clear();
      } else {
        activeStore.write(live);
      }
    });

    const configPath = globalConfigPath(home);
    const previousConfig = spliceOauthAccount(configPath, target);
    undo.push(() => {
      writeFilePrivate(configPath, previousConfig);
    });

    const previousAccountId = vault.activeAccountId();
    vault.setActive(target.accountId);
    undo.push(() => {
      vault.setActive(previousAccountId);
    });

    activeStore.touch();
    return {
      target,
      previousAccountId,
      outgoing: outgoing.kind,
      stashId,
      backend: activeStore.backend,
      liveSessions,
      warnings,
    };
  } catch (error) {
    const failures: string[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (rollbackError) {
        failures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (failures.length > 0) {
      throw new SwitchError(
        `switch failed (${detail}) and rollback also failed (${failures.join('; ')}) — check "llmtally accounts" and re-login if needed`,
      );
    }
    throw error instanceof CredentialError || error instanceof SwitchError
      ? error
      : new SwitchError(`switch failed and was rolled back: ${detail}`);
  } finally {
    locks.release();
  }
}

/** Snapshot of the account that is logged in right now. */
export function captureActiveAccount(ports: {
  readonly vault: AccountVault;
  readonly activeStore: ActiveCredentialStore;
  readonly home?: string;
  readonly alias?: string | null;
  readonly nowUtc?: number;
}): VaultEntry {
  const home = ports.home ?? homedir();
  const identity = readClaudeActiveIdentity(globalConfigPath(home));
  const accountId = identity?.accountUuid ?? null;
  if (identity === null || accountId === null) {
    throw new SwitchError(
      'no logged-in Claude Code account found in ~/.claude.json — run "claude" and /login first',
    );
  }
  const live = ports.activeStore.read();
  if (live === null) {
    throw new SwitchError(
      'could not read the active Claude Code credentials (empty or unreadable) — nothing was stored',
    );
  }
  if (isWipedCredential(live)) {
    throw new SwitchError('the active credentials are blank (signed out) — nothing was stored');
  }
  const existing = ports.vault.get(accountId);
  const stored = ports.vault.put(
    {
      agent: 'claude-code',
      accountId,
      email: identity.email,
      organizationUuid: identity.organizationUuid,
      organizationName: identity.organizationName,
      alias: ports.alias === undefined ? (existing?.alias ?? null) : ports.alias,
      addedAtUtc: existing?.addedAtUtc ?? ports.nowUtc ?? Math.floor(Date.now() / 1000),
      // a capture is proof of a working login; lift any quarantine
      refreshDeadAtUtc: null,
    },
    compactJson(live),
  );
  ports.vault.setActive(accountId);
  return stored;
}
