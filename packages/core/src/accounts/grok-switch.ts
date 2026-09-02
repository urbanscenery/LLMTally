/**
 * Grok account switching — the third user-approved exception (2026-08-17)
 * to "never write into an agent's store". A switch splices ONE entry of
 * `~/.grok/auth.json` (the map key `<oidc_issuer>::<client_id>` names the
 * slot); every other entry in the file is preserved byte-identical.
 *
 * Three things make the write safe:
 *
 *   - The Grok CLI guards its own rewrites with flock(2) on
 *     `auth.json.lock` (observed in the 1.0.4 binary: "could not acquire
 *     auth.json.lock within timeout; sibling may be mid-refresh"), so the
 *     switch takes the same lock before touching the file. flock dies
 *     with its holder — no stale-lock reclaim is needed. No network I/O
 *     ever happens while the lock is held.
 *   - The outgoing record is preserved first: backed up onto its vault
 *     entry when the refresh-token lineage matches a stored account,
 *     captured + stashed under `unclaimed/` when it matches nobody.
 *   - A re-read CAS aborts on any concurrent change a non-flock writer
 *     might have made, and the activation itself is a same-directory
 *     temp write + rename.
 *
 * Unlike codex nothing has to be detached first: the CLI's login flow
 * revokes nothing (its binary carries no revoke call), so a stored copy
 * of the displaced login stays alive.
 */
import { closeSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { FFIType, dlopen } from 'bun:ffi';

import { asObject } from '../parsers/shared.ts';
import { writeFilePrivate } from '../fs/atomic.ts';
import {
  GROK_AGENT,
  GrokAccountError,
  defaultGrokAuthPath,
  grokEntryFingerprint,
  putGrokEntry,
  readGrokAuthEntries,
  readStoredGrokEntry,
  serializeGrokEntry,
} from './grok.ts';
import type { GrokAuthEntry } from './grok.ts';
import type { AccountVault, VaultEntry } from './vault.ts';

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const LOCK_TIMEOUT_MS = 9000;
const LOCK_RETRY_DELAY_MS = 100;

export interface GrokAuthLockHandle {
  release(): void;
}

/** Test seam: production uses flock(2), tests inject a fake. */
export type GrokAuthLockAcquire = (lockPath: string) => Promise<GrokAuthLockHandle>;

type FlockFn = (fd: number, operation: number) => number;

let cachedFlock: FlockFn | null | undefined;

/** libc flock via bun:ffi; null when the platform cannot provide it. */
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

/**
 * Takes the Grok CLI's own advisory lock. The lock file is opened in
 * append mode — created when absent, never truncated: the CLI writes a
 * small payload into it and clobbering that would be a write into the
 * agent's store this path has no business making.
 */
export const acquireGrokAuthLock: GrokAuthLockAcquire = async (lockPath) => {
  const flock = nativeFlock();
  if (flock === null) {
    throw new GrokAccountError(
      'cannot take auth.json.lock on this platform (no flock) — refusing to switch under a running grok',
    );
  }
  let fd: number;
  try {
    fd = openSync(lockPath, 'a', 0o600);
  } catch (error) {
    // ~/.grok itself is missing on a machine that never installed the
    // CLI; a raw ENOENT would say nothing useful
    throw new GrokAccountError(
      `cannot open ${lockPath} (${error instanceof Error ? error.message : String(error)}) — is the grok CLI installed?`,
    );
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
      break;
    }
    if (Date.now() >= deadline) {
      closeSync(fd);
      throw new GrokAccountError(
        'timed out waiting for auth.json.lock — a grok process is mid-refresh; try again',
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

function readAuthFile(authPath: string): string | null {
  try {
    const text = readFileSync(authPath, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** Resolves an id, alias, or email — among grok entries only. */
function resolveGrokEntry(vault: AccountVault, selector: string): VaultEntry {
  const entries = vault.list().filter((entry) => entry.agent === GROK_AGENT);
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
    throw new GrokAccountError(
      `"${selector}" matches ${byEmail.length} grok accounts — use the account id`,
    );
  }
  throw new GrokAccountError(`no stored grok account matches "${selector}"`);
}

export type GrokOutgoingKind = 'own' | 'unclaimed' | 'absent';

export interface GrokSwitchResult {
  readonly target: VaultEntry;
  readonly outgoing: GrokOutgoingKind;
  readonly stashId: string | null;
  readonly warnings: readonly string[];
}

/**
 * Preserves the record the splice is about to displace. `own` when its
 * lineage matches a stored account (backed up in place), `unclaimed`
 * when it matches nobody (captured and stashed as evidence).
 */
function preserveOutgoing(
  vault: AccountVault,
  displaced: GrokAuthEntry,
  now: number,
  warnings: string[],
): { outgoing: GrokOutgoingKind; stashId: string | null } {
  const fingerprint = grokEntryFingerprint(displaced);
  const owner = vault
    .list()
    .filter((entry) => entry.agent === GROK_AGENT)
    .find((entry) => {
      // an unreadable third account reads as "no match", not a veto:
      // the outgoing login is still captured/stashed below
      let stored: string | null;
      try {
        stored = vault.loadCredentials(GROK_AGENT, entry.accountId);
      } catch {
        return false;
      }
      const storedEntry = stored === null ? null : readStoredGrokEntry(stored);
      return storedEntry !== null && grokEntryFingerprint(storedEntry) === fingerprint;
    });
  if (owner !== undefined) {
    const { backend: _backend, ...rest } = owner;
    vault.put({ ...rest, refreshDeadAtUtc: null }, serializeGrokEntry(displaced));
    return { outgoing: 'own', stashId: null };
  }
  if (displaced.accountId !== null) {
    // identity readable but lineage unknown: capture it as its own
    // account rather than losing a login the vault simply never saw
    putGrokEntry(vault, displaced, { nowUtc: now });
    const stashId = vault.stashUnclaimed(
      serializeGrokEntry(displaced),
      'grok credentials did not match any stored account',
      now,
    );
    warnings.push(
      `the live grok login was not stored; captured it as ${displaced.email ?? displaced.accountId} and kept a copy as unclaimed/${stashId}`,
    );
    return { outgoing: 'unclaimed', stashId };
  }
  const stashId = vault.stashUnclaimed(
    serializeGrokEntry(displaced),
    'unattributable grok credentials before switch',
    now,
  );
  warnings.push(`the displaced grok record carried no user id; kept a copy as unclaimed/${stashId}`);
  return { outgoing: 'unclaimed', stashId };
}

export async function switchGrokAccount(
  selector: string,
  ports: {
    readonly vault: AccountVault;
    readonly authPath?: string;
    readonly nowUtc?: number;
    /** Test seam: runs between the CAS re-read and the write. */
    readonly beforeWrite?: () => void;
    /** Test seam: production takes flock on `<authPath>.lock`. */
    readonly acquireLock?: GrokAuthLockAcquire;
  },
): Promise<GrokSwitchResult> {
  const authPath = ports.authPath ?? defaultGrokAuthPath(homedir());
  const now = ports.nowUtc ?? Math.floor(Date.now() / 1000);
  const { vault } = ports;

  const target = resolveGrokEntry(vault, selector);
  if (target.refreshDeadAtUtc !== null) {
    throw new GrokAccountError(
      `the stored login for ${target.email ?? target.accountId} was rejected — run "grok" and sign in as that account once, then press n to re-capture it`,
    );
  }
  const storedText = vault.loadCredentials(GROK_AGENT, target.accountId);
  const storedEntry = storedText === null ? null : readStoredGrokEntry(storedText);
  if (storedEntry === null) {
    throw new GrokAccountError(
      `no stored credentials for ${target.email ?? target.accountId} — press n while logged in as that account`,
    );
  }

  const warnings: string[] = [];
  const live = readAuthFile(authPath);
  const liveEntries = live === null ? [] : readGrokAuthEntries(live);
  if (liveEntries.some((entry) => entry.accountId === target.accountId)) {
    warnings.push(`${target.email ?? target.accountId} is already an active grok login`);
    return { target, outgoing: 'absent', stashId: null, warnings };
  }

  // splice basis: only the target's issuer::client slot moves; every
  // other entry is carried over from the live document untouched. An
  // unparseable-but-present file aborts BEFORE the vault is touched.
  let document: Record<string, unknown> = {};
  if (live !== null) {
    try {
      document = asObject(JSON.parse(live)) ?? {};
    } catch {
      throw new GrokAccountError(
        'auth.json is unreadable right now (mid-rewrite?) — try again in a moment',
      );
    }
  }

  // preserve whatever the splice displaces before anything is written.
  // This happens OUTSIDE the flock on purpose: a vault backup can chain
  // Keychain calls for seconds, and holding the CLI's own lock that
  // long would push its refresh path into lock-timeout stale recovery.
  const displaced = liveEntries.find((entry) => entry.entryKey === storedEntry.entryKey);
  let outgoing: GrokOutgoingKind = 'absent';
  let stashId: string | null = null;
  if (displaced !== undefined) {
    ({ outgoing, stashId } = preserveOutgoing(vault, displaced, now, warnings));
  }

  // the critical section is a re-read CAS plus one rename — no vault,
  // no keychain, no network while the CLI's lock is held
  const lock = await (ports.acquireLock ?? acquireGrokAuthLock)(`${authPath}.lock`);
  try {
    ports.beforeWrite?.();
    if (readAuthFile(authPath) !== live) {
      // the preserved outgoing generation is no longer what the file
      // holds; writing would clobber a rotation the vault never saw
      throw new GrokAccountError(
        'auth.json changed while switching (grok rotated its token) — try again',
      );
    }
    writeFilePrivate(
      authPath,
      JSON.stringify({ ...document, [storedEntry.entryKey]: storedEntry.record }, null, 2),
    );
  } finally {
    lock.release();
  }
  warnings.push(
    'a running grok session may adopt the switched login on its next token refresh, or keep its old one until restarted',
  );
  return { target, outgoing, stashId, warnings };
}
