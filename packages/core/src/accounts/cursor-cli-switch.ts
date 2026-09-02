/**
 * Cursor CLI account switching — the fourth user-approved exception
 * to "never write into an agent's store". A switch splices only
 * `authInfo` and the two `authCacheKey` fields of
 * `~/.cursor/cli-config.json`, then replaces the three Keychain items
 * (or `~/.cursor/auth.json` on the file backend). Model, permission,
 * and approval fields stay byte-identical.
 *
 * flock(2) on `cli-config.json.lock` (append, never truncate) covers
 * the critical section. No network I/O while it is held.
 */
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { FFIType, dlopen } from 'bun:ffi';

import { writeFilePrivate } from '../fs/atomic.ts';
import { asObject } from '../parsers/shared.ts';
import {
  CURSOR_CLI_AGENT,
  CURSOR_CLI_KEYCHAIN,
  CursorCliAccountError,
  credentialsFromVaultDocument,
  cursorCliCredentialFingerprint,
  defaultCursorCliAuthPath,
  defaultCursorCliConfigPath,
  defaultCursorCliLockPath,
  readCursorCliCredentials,
  readCursorCliIdentity,
  readStoredCursorCliDocument,
  serializeCursorCliVaultDocument,
} from './cursor-cli.ts';
import type { CursorCliCredentials, CursorCliIdentity, CursorCliVaultDocument } from './cursor-cli.ts';
import { macosKeychain } from './keychain.ts';
import type { KeychainPort } from './keychain.ts';
import {
  assertSwitchCooldown,
  defaultSwitchCooldownPath,
  recordSwitchCooldown,
} from './switch-cooldown.ts';
import type { AccountVault, VaultEntry } from './vault.ts';

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const LOCK_TIMEOUT_MS = 9000;
const LOCK_RETRY_DELAY_MS = 100;
const PS_BIN = '/bin/ps';

export interface CursorCliLockHandle {
  release(): void;
}

export type CursorCliLockAcquire = (lockPath: string) => Promise<CursorCliLockHandle>;

type FlockFn = (fd: number, operation: number) => number;

let cachedFlock: FlockFn | null | undefined;

function nativeFlock(): FlockFn | null {
  if (cachedFlock !== undefined) {
    return cachedFlock;
  }
  try {
    const library = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
    const lib = dlopen(library, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    cachedFlock = (fd, operation) => lib.symbols.flock(fd, operation);
  } catch {
    cachedFlock = null;
  }
  return cachedFlock;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const acquireCursorCliConfigLock: CursorCliLockAcquire = async (lockPath) => {
  const flock = nativeFlock();
  if (flock === null) {
    throw new CursorCliAccountError(
      'cannot take cli-config.json.lock on this platform (no flock) — refusing to switch under a running cursor-agent',
    );
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // open below reports the real failure
  }
  let fd: number;
  try {
    fd = openSync(lockPath, 'a', 0o600);
  } catch (error) {
    throw new CursorCliAccountError(
      `cannot open ${lockPath} (${error instanceof Error ? error.message : String(error)}) — is Cursor CLI installed?`,
    );
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
      break;
    }
    if (Date.now() >= deadline) {
      closeSync(fd);
      throw new CursorCliAccountError(
        'timed out waiting for cli-config.json.lock — a cursor-agent process is mid-write; try again',
      );
    }
    await sleep(LOCK_RETRY_DELAY_MS);
  }
  let released = false;
  return {
    release(): void {
      if (released) {
        return;
      }
      released = true;
      try {
        flock(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    },
  };
};

function readText(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** PIDs whose command path contains `cursor-agent` — warn, never block. */
export function cursorAgentPids(): number[] {
  const result = Bun.spawnSync([PS_BIN, '-ax', '-o', 'pid=,command='], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 2000,
  });
  if ((result.exitCode ?? 1) !== 0) {
    return [];
  }
  const pids: number[] = [];
  for (const line of result.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      continue;
    }
    if (match[2].includes('cursor-agent')) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid)) {
        pids.push(pid);
      }
    }
  }
  return pids;
}

function resolveCursorCliEntry(vault: AccountVault, selector: string): VaultEntry {
  const entries = vault.list().filter((entry) => entry.agent === CURSOR_CLI_AGENT);
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
    throw new CursorCliAccountError(
      `"${selector}" matches ${byEmail.length} cursor-cli accounts — use the account id`,
    );
  }
  throw new CursorCliAccountError(`no stored cursor-cli account matches "${selector}"`);
}

export type CursorCliOutgoingKind = 'own' | 'unclaimed' | 'absent';

export interface CursorCliSwitchResult {
  readonly target: VaultEntry;
  readonly outgoing: CursorCliOutgoingKind;
  readonly stashId: string | null;
  readonly warnings: readonly string[];
  readonly liveSessions: readonly number[];
}

function documentFromLive(
  identity: CursorCliIdentity,
  credentials: CursorCliCredentials,
  nowUtc: number,
): CursorCliVaultDocument {
  return {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    apiKey: credentials.apiKey,
    authId: identity.authId,
    email: identity.email,
    displayName: identity.displayName,
    userId: identity.accountId,
    capturedAtUtc: nowUtc,
  };
}

function putLiveAccount(
  vault: AccountVault,
  identity: CursorCliIdentity,
  credentials: CursorCliCredentials,
  nowUtc: number,
): void {
  const existing = vault.get(CURSOR_CLI_AGENT, identity.accountId);
  vault.put(
    {
      agent: CURSOR_CLI_AGENT,
      accountId: identity.accountId,
      email: identity.email,
      organizationUuid: null,
      organizationName: null,
      alias: existing?.alias ?? null,
      addedAtUtc: existing?.addedAtUtc ?? nowUtc,
      refreshDeadAtUtc: null,
    },
    serializeCursorCliVaultDocument(documentFromLive(identity, credentials, nowUtc)),
  );
}

function preserveOutgoing(
  vault: AccountVault,
  identity: CursorCliIdentity | null,
  credentials: CursorCliCredentials | null,
  nowUtc: number,
  warnings: string[],
): { outgoing: CursorCliOutgoingKind; stashId: string | null } {
  if (credentials === null) {
    if (identity !== null) {
      warnings.push(
        'the live cursor-cli slot named an account but had no token; nothing was backed up',
      );
    }
    return { outgoing: 'absent', stashId: null };
  }
  const fingerprint = cursorCliCredentialFingerprint(credentials);
  const owner = vault
    .list()
    .filter((entry) => entry.agent === CURSOR_CLI_AGENT)
    .find((entry) => {
      let stored: string | null;
      try {
        stored = vault.loadCredentials(CURSOR_CLI_AGENT, entry.accountId);
      } catch {
        return false;
      }
      const document = stored === null ? null : readStoredCursorCliDocument(stored);
      return (
        document !== null &&
        cursorCliCredentialFingerprint(credentialsFromVaultDocument(document)) === fingerprint
      );
    });
  if (owner !== undefined && identity !== null) {
    const { backend: _backend, ...rest } = owner;
    vault.put(
      { ...rest, refreshDeadAtUtc: null },
      serializeCursorCliVaultDocument(documentFromLive(identity, credentials, nowUtc)),
    );
    return { outgoing: 'own', stashId: null };
  }
  if (identity !== null) {
    putLiveAccount(vault, identity, credentials, nowUtc);
    const stashId = vault.stashUnclaimed(
      serializeCursorCliVaultDocument(documentFromLive(identity, credentials, nowUtc)),
      'cursor-cli credentials did not match any stored account',
      nowUtc,
    );
    warnings.push(
      `the live cursor-cli login was not stored; captured it as ${identity.email ?? identity.accountId} and kept a copy as unclaimed/${stashId}`,
    );
    return { outgoing: 'unclaimed', stashId };
  }
  const stashId = vault.stashUnclaimed(
    JSON.stringify({
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      apiKey: credentials.apiKey,
    }),
    'unattributable cursor-cli credentials before switch',
    nowUtc,
  );
  warnings.push(
    `the displaced cursor-cli credentials carried no user id; kept a copy as unclaimed/${stashId}`,
  );
  return { outgoing: 'unclaimed', stashId };
}

function userIdForConfig(accountId: string): string | number {
  return /^\d+$/.test(accountId) ? Number(accountId) : accountId;
}

export function spliceCursorCliConfig(
  document: Record<string, unknown>,
  stored: CursorCliVaultDocument,
): Record<string, unknown> {
  const authInfo = { ...(asObject(document.authInfo) ?? {}) };
  authInfo.email = stored.email;
  authInfo.displayName = stored.displayName;
  authInfo.userId = userIdForConfig(stored.userId);
  authInfo.authId = stored.authId;
  const next: Record<string, unknown> = { ...document, authInfo };
  if (stored.authId !== null) {
    const cacheKey = `auth:${stored.authId}`;
    const auto = { ...(asObject(document.autoReviewAvailabilityCache) ?? {}) };
    auto.authCacheKey = cacheKey;
    const server = { ...(asObject(document.serverConfigCache) ?? {}) };
    server.authCacheKey = cacheKey;
    next.autoReviewAvailabilityCache = auto;
    next.serverConfigCache = server;
  }
  return next;
}

function writeLiveCredentials(
  home: string,
  stored: CursorCliVaultDocument,
  keychain: KeychainPort,
  fileStore: boolean,
): void {
  if (fileStore || !keychain.available) {
    writeFilePrivate(
      defaultCursorCliAuthPath(home),
      JSON.stringify({
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        apiKey: stored.apiKey,
      }),
    );
    return;
  }
  keychain.write(CURSOR_CLI_KEYCHAIN.accessService, CURSOR_CLI_KEYCHAIN.account, stored.accessToken);
  if (stored.refreshToken !== null) {
    keychain.write(
      CURSOR_CLI_KEYCHAIN.refreshService,
      CURSOR_CLI_KEYCHAIN.account,
      stored.refreshToken,
    );
  } else {
    keychain.remove(CURSOR_CLI_KEYCHAIN.refreshService, CURSOR_CLI_KEYCHAIN.account);
  }
  if (stored.apiKey !== null) {
    keychain.write(CURSOR_CLI_KEYCHAIN.apiKeyService, CURSOR_CLI_KEYCHAIN.account, stored.apiKey);
  } else {
    keychain.remove(CURSOR_CLI_KEYCHAIN.apiKeyService, CURSOR_CLI_KEYCHAIN.account);
  }
}

function restoreLiveCredentials(
  home: string,
  previous: CursorCliCredentials | null,
  previousAuthText: string | null,
  keychain: KeychainPort,
  fileStore: boolean,
): void {
  if (fileStore || !keychain.available) {
    if (previousAuthText === null) {
      return;
    }
    writeFilePrivate(defaultCursorCliAuthPath(home), previousAuthText);
    return;
  }
  if (previous === null) {
    keychain.remove(CURSOR_CLI_KEYCHAIN.accessService, CURSOR_CLI_KEYCHAIN.account);
    keychain.remove(CURSOR_CLI_KEYCHAIN.refreshService, CURSOR_CLI_KEYCHAIN.account);
    keychain.remove(CURSOR_CLI_KEYCHAIN.apiKeyService, CURSOR_CLI_KEYCHAIN.account);
    return;
  }
  keychain.write(CURSOR_CLI_KEYCHAIN.accessService, CURSOR_CLI_KEYCHAIN.account, previous.accessToken);
  if (previous.refreshToken !== null) {
    keychain.write(
      CURSOR_CLI_KEYCHAIN.refreshService,
      CURSOR_CLI_KEYCHAIN.account,
      previous.refreshToken,
    );
  } else {
    keychain.remove(CURSOR_CLI_KEYCHAIN.refreshService, CURSOR_CLI_KEYCHAIN.account);
  }
  if (previous.apiKey !== null) {
    keychain.write(CURSOR_CLI_KEYCHAIN.apiKeyService, CURSOR_CLI_KEYCHAIN.account, previous.apiKey);
  } else {
    keychain.remove(CURSOR_CLI_KEYCHAIN.apiKeyService, CURSOR_CLI_KEYCHAIN.account);
  }
}

export async function switchCursorCliAccount(
  selector: string,
  ports: {
    readonly vault: AccountVault;
    readonly home?: string;
    readonly nowUtc?: number;
    readonly keychain?: KeychainPort;
    readonly fileStore?: boolean;
    readonly cooldownPath?: string;
    readonly beforeWrite?: () => void;
    readonly acquireLock?: CursorCliLockAcquire;
  },
): Promise<CursorCliSwitchResult> {
  const home = ports.home ?? homedir();
  const now = ports.nowUtc ?? Math.floor(Date.now() / 1000);
  const fileStore =
    ports.fileStore === true || process.env.AGENT_CLI_CREDENTIAL_STORE === 'file';
  const keychain = ports.keychain ?? macosKeychain;
  const configPath = defaultCursorCliConfigPath(home);
  const warnings: string[] = [];

  assertSwitchCooldown(ports.cooldownPath ?? defaultSwitchCooldownPath(home), now);
  const liveSessions = cursorAgentPids();
  if (liveSessions.length > 0) {
    warnings.push(
      `${liveSessions.length} cursor-agent process(es) are running and may keep the previous token until restarted`,
    );
  }

  const target = resolveCursorCliEntry(ports.vault, selector);
  if (target.refreshDeadAtUtc !== null) {
    throw new CursorCliAccountError(
      `the stored login for ${target.email ?? target.accountId} was rejected — run "cursor agent login" as this account once (llmtally auto-heals)`,
    );
  }
  const storedText = ports.vault.loadCredentials(CURSOR_CLI_AGENT, target.accountId);
  const stored = storedText === null ? null : readStoredCursorCliDocument(storedText);
  if (stored === null) {
    throw new CursorCliAccountError(
      `no stored credentials for ${target.email ?? target.accountId} — press n while logged in as that account`,
    );
  }

  const outgoingRead = readCursorCliCredentials({ home, keychain, fileStore });
  if (outgoingRead.kind === 'error') {
    throw new CursorCliAccountError(outgoingRead.message);
  }
  const liveIdentity = readCursorCliIdentity(home);
  if (liveIdentity?.accountId === target.accountId) {
    warnings.push(`${target.email ?? target.accountId} is already the active cursor-cli login`);
    return {
      target,
      outgoing: 'absent',
      stashId: null,
      warnings,
      liveSessions,
    };
  }

  const liveConfig = readText(configPath);
  if (liveConfig !== null) {
    try {
      if (asObject(JSON.parse(liveConfig)) === null) {
        throw new Error('not an object');
      }
    } catch {
      throw new CursorCliAccountError(
        'cli-config.json is unreadable right now (mid-rewrite?) — try again in a moment',
      );
    }
  }

  const outgoingCredentials = outgoingRead.kind === 'found' ? outgoingRead.credentials : null;
  const { outgoing, stashId } = preserveOutgoing(
    ports.vault,
    liveIdentity,
    outgoingCredentials,
    now,
    warnings,
  );

  const previousAuthText = readText(defaultCursorCliAuthPath(home));
  const lock = await (ports.acquireLock ?? acquireCursorCliConfigLock)(defaultCursorCliLockPath(home));
  let wroteCredentials = false;
  try {
    ports.beforeWrite?.();
    if (readText(configPath) !== liveConfig) {
      throw new CursorCliAccountError('cli-config.json changed while switching — try again');
    }
    writeLiveCredentials(home, stored, keychain, fileStore);
    wroteCredentials = true;
    const basis = liveConfig === null ? {} : (asObject(JSON.parse(liveConfig)) ?? {});
    writeFilePrivate(configPath, `${JSON.stringify(spliceCursorCliConfig(basis, stored), null, 2)}\n`);
  } catch (error) {
    if (wroteCredentials) {
      if (liveConfig !== null) {
        try {
          writeFilePrivate(configPath, liveConfig);
        } catch {
          warnings.push('rollback of cli-config.json failed; re-login may be required');
        }
      }
      try {
        restoreLiveCredentials(home, outgoingCredentials, previousAuthText, keychain, fileStore);
      } catch {
        warnings.push('rollback of cursor-cli credentials failed; re-login may be required');
      }
    }
    throw error;
  } finally {
    lock.release();
  }
  recordSwitchCooldown(ports.cooldownPath ?? defaultSwitchCooldownPath(home), now);
  return { target, outgoing, stashId, warnings, liveSessions };
}
