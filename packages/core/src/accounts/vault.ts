/**
 * llmtally's own account store, the thing that makes switching possible
 * at all. Layout under `~/.llmtally/accounts` (0700):
 *
 *   registry.json          labels + which account is active
 *   <accountId>.cred       base64 credentials (file backend)
 *   unclaimed/<id>.cred    credentials we could not attribute, kept
 *                          with a manifest instead of being destroyed
 *
 * On macOS the credentials live in the Keychain (service `llmtally`,
 * account `claude:<accountId>`) and the `.cred` file is absent; the
 * file backend is the fallback when no Keychain is available. Secrets
 * are base64 so a Keychain item is always a single safe line — that is
 * encoding, not encryption.
 */
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';
import { credentialFingerprint, writeFilePrivate } from './credentials.ts';
import { macosKeychain } from './keychain.ts';
import type { KeychainPort } from './keychain.ts';

export const VAULT_KEYCHAIN_SERVICE = 'llmtally';
const DIRECTORY_MODE = 0o700;
const REGISTRY_VERSION = 1;
/**
 * Per-caller waits for the mutation lock. Quota polling must never
 * stall (0), a rotated-credential persist must not be lost over a
 * transient hold (long), and a user-triggered put sits in between.
 */
const MARK_DEAD_LOCK_WAIT_MS = 0;
// must exceed the worst legitimate hold: a Keychain #storeEntry can
// chain several `security` calls (~5s each) plus recovery/removal
const REPLACE_LOCK_WAIT_MS = 60_000;
const PUT_LOCK_WAIT_MS = 10_000;

export class VaultError extends Error {
  override readonly name = 'VaultError';
}

export interface VaultEntry {
  /** Which agent this login belongs to; only claude-code today. */
  readonly agent: string;
  readonly accountId: string;
  readonly email: string | null;
  readonly organizationUuid: string | null;
  readonly organizationName: string | null;
  readonly alias: string | null;
  readonly addedAtUtc: number;
  readonly backend: 'keychain' | 'file';
  /**
   * Set when the stored refresh-token lineage was rejected by the token
   * endpoint (`invalid_grant`): polling must stop hitting the endpoint
   * with a dead token. Cleared by a successful refresh or a re-capture
   * of fresh credentials. Absent in older registries → null.
   */
  readonly refreshDeadAtUtc: number | null;
}

/**
 * Outcome of a compare-and-swap credential mutation. `changed` means
 * the stored lineage moved under us (another process refreshed or
 * re-captured first) and nothing was written; `busy` means another
 * mutation holds the lock right now.
 */
export type VaultCredentialMutation = 'updated' | 'changed' | 'missing' | 'busy';

interface RegistryFile {
  readonly version: number;
  readonly activeAccountId: string | null;
  readonly accounts: Record<string, Omit<VaultEntry, 'accountId'>>;
}

const ALIAS_PATTERN = /^[a-z0-9_.-]+$/;
/**
 * Account ids come from `~/.claude.json`, a plain file any local
 * process can edit, and they end up in a filename and in a `security`
 * command line. Restricting them to this charset is what stops a
 * crafted id from escaping the vault directory or injecting a second
 * `security` command through an embedded newline.
 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

export function assertSafeAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || accountId.includes('..')) {
    throw new VaultError(
      `refusing to use account id "${accountId}" — expected a uuid or address (letters, digits, ".", "_", "@", "-")`,
    );
  }
  return accountId;
}

/** Aliases must never be mistaken for a slot number or a flag. */
export function normalizeAlias(value: string): string {
  const alias = value.trim().toLowerCase();
  if (!ALIAS_PATTERN.test(alias) || /^\d+$/.test(alias) || alias.startsWith('-')) {
    throw new VaultError(
      `invalid alias "${value}" — use lowercase letters, digits, "_", ".", "-" and not only digits`,
    );
  }
  return alias;
}

export function defaultVaultDir(home: string = homedir()): string {
  return join(home, '.llmtally', 'accounts');
}

export class AccountVault {
  readonly #dir: string;
  readonly #keychain: KeychainPort;
  readonly #writeLockWaitMs: number;

  constructor(
    options: {
      readonly dir?: string;
      readonly keychain?: KeychainPort;
      /** Test seam: how long user-path writes wait for the lock. */
      readonly writeLockWaitMs?: number;
    } = {},
  ) {
    this.#dir = options.dir ?? defaultVaultDir();
    this.#keychain = options.keychain ?? macosKeychain;
    this.#writeLockWaitMs = options.writeLockWaitMs ?? PUT_LOCK_WAIT_MS;
  }

  get directory(): string {
    return this.#dir;
  }

  list(): VaultEntry[] {
    const registry = this.#readRegistry();
    return Object.entries(registry.accounts).map(([accountId, entry]) => ({ accountId, ...entry }));
  }

  activeAccountId(): string | null {
    return this.#readRegistry().activeAccountId;
  }

  get(accountId: string): VaultEntry | null {
    return this.list().find((entry) => entry.accountId === accountId) ?? null;
  }

  /**
   * Resolves an account id, alias, or email. An email that matches more
   * than one account is rejected rather than guessed — the same address
   * can belong to both a personal and an organization account.
   */
  resolve(selector: string): VaultEntry {
    const entries = this.list();
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
      throw new VaultError(
        `"${selector}" matches ${byEmail.length} accounts — use the account id or an alias`,
      );
    }
    throw new VaultError(`no stored account matches "${selector}" (see "llmtally accounts")`);
  }

  /**
   * Stores or replaces an account together with its credentials.
   * `refreshDeadAtUtc` may be omitted, in which case an existing
   * entry's quarantine state is preserved (a metadata refresh must not
   * silently revive a dead lineage).
   *
   * Takes the mutation lock (bounded wait) so a direct write can never
   * interleave with a fingerprint CAS in another process. A lock still
   * busy after the wait fails the write loudly — writing unlocked would
   * reintroduce the lost-generation race this lock exists to prevent.
   */
  put(
    entry: Omit<VaultEntry, 'backend' | 'refreshDeadAtUtc'> & {
      readonly refreshDeadAtUtc?: number | null;
    },
    credentialsText: string,
  ): VaultEntry {
    let stored: VaultEntry | null = null;
    const attempt = this.#withMutationLock(this.#writeLockWaitMs, () => {
      stored = this.#storeEntry(entry, credentialsText);
      return 'updated';
    });
    if (attempt === 'busy' || stored === null) {
      throw new VaultError(
        'another credential operation is holding the vault lock — try again in a moment',
      );
    }
    return stored;
  }

  /** The unlocked write; every locked path funnels through here. */
  #storeEntry(
    entry: Omit<VaultEntry, 'backend' | 'refreshDeadAtUtc'> & {
      readonly refreshDeadAtUtc?: number | null;
    },
    credentialsText: string,
  ): VaultEntry {
    if (credentialsText.length === 0) {
      throw new VaultError('refusing to store empty credentials');
    }
    assertSafeAccountId(entry.accountId);
    this.#ensureDir();
    const encoded = Buffer.from(credentialsText, 'utf8').toString('base64');
    let backend: VaultEntry['backend'] = 'file';
    if (this.#keychain.available) {
      try {
        this.#keychain.write(VAULT_KEYCHAIN_SERVICE, this.#keychainAccount(entry.agent, entry.accountId), encoded);
        backend = 'keychain';
      } catch {
        // falling back to a file is only safe if the older Keychain row
        // goes away: reads prefer the Keychain, so leaving it would hide
        // the credentials we just stored behind a stale copy
        this.#keychain.remove(VAULT_KEYCHAIN_SERVICE, this.#keychainAccount(entry.agent, entry.accountId));
        backend = 'file';
      }
    }
    if (backend === 'file') {
      writeFilePrivate(this.#credentialPath(entry.accountId), encoded);
    } else {
      // a stale plaintext copy must not outlive a successful Keychain write
      rmSync(this.#credentialPath(entry.accountId), { force: true });
    }
    const registry = this.#readRegistry();
    const refreshDeadAtUtc =
      entry.refreshDeadAtUtc !== undefined
        ? entry.refreshDeadAtUtc
        : (registry.accounts[entry.accountId]?.refreshDeadAtUtc ?? null);
    const stored: VaultEntry = { ...entry, backend, refreshDeadAtUtc };
    const { accountId, ...rest } = stored;
    this.#writeRegistry({
      ...registry,
      accounts: { ...registry.accounts, [accountId]: rest },
    });
    return stored;
  }

  /**
   * Quarantines the stored refresh lineage — but only when the caller
   * still holds the generation it judged (`expectedFingerprint`). If
   * the credentials changed underneath (another process refreshed or
   * re-captured), the verdict belonged to bytes that no longer exist.
   */
  markRefreshDeadIfFingerprint(
    accountId: string,
    expectedFingerprint: string,
    nowUtc: number,
  ): VaultCredentialMutation {
    return this.#withMutationLock(MARK_DEAD_LOCK_WAIT_MS, () => {
      const registry = this.#readRegistry();
      const entry = registry.accounts[accountId];
      const current = this.loadCredentials(accountId);
      if (entry === undefined || current === null) {
        return 'missing';
      }
      if (credentialFingerprint(current) !== expectedFingerprint) {
        return 'changed';
      }
      this.#writeRegistry({
        ...registry,
        accounts: {
          ...registry.accounts,
          [accountId]: { ...entry, refreshDeadAtUtc: nowUtc },
        },
      });
      return 'updated';
    });
  }

  /**
   * Persists a rotated credential generation, guarded by the same CAS:
   * a slow refresh that lands after a re-capture must not clobber the
   * fresher bytes with an already-superseded rotation.
   */
  replaceCredentialsIfFingerprint(
    accountId: string,
    expectedFingerprint: string,
    credentialsText: string,
    options: { readonly clearRefreshDead: boolean },
  ): VaultCredentialMutation {
    return this.#withMutationLock(REPLACE_LOCK_WAIT_MS, () => {
      const entry = this.get(accountId);
      const current = this.loadCredentials(accountId);
      if (entry === null || current === null) {
        return 'missing';
      }
      if (credentialFingerprint(current) !== expectedFingerprint) {
        return 'changed';
      }
      const { backend: _backend, ...rest } = entry;
      this.#storeEntry(
        {
          ...rest,
          refreshDeadAtUtc: options.clearRefreshDead ? null : entry.refreshDeadAtUtc,
        },
        credentialsText,
      );
      return 'updated';
    });
  }

  /**
   * Serializes credential mutations across processes. The lock is a
   * `BEGIN IMMEDIATE` transaction on a dedicated SQLite file in the
   * vault directory: acquisition is atomic in the kernel, contention is
   * answered by SQLite's own busy handling (bounded by `waitMs`), and a
   * crashed holder's lock evaporates with its process — no lock files,
   * no TTLs, no reclaim races. Network calls never happen inside the
   * lock; the longest hold is a Keychain write.
   */
  #withMutationLock(
    waitMs: number,
    mutate: () => Exclude<VaultCredentialMutation, 'busy'>,
  ): VaultCredentialMutation {
    this.#ensureDir();
    const lockPath = join(this.#dir, '.mutation-lock.db');
    let lockDb: Database;
    try {
      lockDb = new Database(lockPath, { create: true, strict: true });
    } catch {
      return 'busy';
    }
    try {
      chmodSync(lockPath, 0o600);
    } catch {
      // permissions are best-effort on a zero-content lock file
    }
    try {
      lockDb.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))};`);
      try {
        lockDb.exec('BEGIN IMMEDIATE;');
      } catch {
        return 'busy';
      }
      try {
        return mutate();
      } finally {
        try {
          lockDb.exec('ROLLBACK;');
        } catch {
          // the close below releases the lock regardless
        }
      }
    } finally {
      lockDb.close();
    }
  }

  loadCredentials(accountId: string): string | null {
    const encoded =
      (this.#keychain.available
        ? this.#keychain.read(VAULT_KEYCHAIN_SERVICE, this.#keychainAccount(this.#agentFor(accountId), accountId))
        : null) ?? this.#readCredentialFile(accountId);
    if (encoded === null) {
      return null;
    }
    try {
      return Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  remove(accountId: string): void {
    // registry + credential removal is a mutation like any other: an
    // unlocked read-modify-write here could resurrect the account by
    // racing a CAS that re-writes the registry from its earlier read
    this.#requireMutationLock(() => {
      this.#keychain.remove(VAULT_KEYCHAIN_SERVICE, this.#keychainAccount(this.#agentFor(accountId), accountId));
      rmSync(this.#credentialPath(accountId), { force: true });
      const registry = this.#readRegistry();
      const { [accountId]: removed, ...remaining } = registry.accounts;
      this.#writeRegistry({
        ...registry,
        activeAccountId: registry.activeAccountId === accountId ? null : registry.activeAccountId,
        accounts: remaining,
      });
    });
  }

  /**
   * `waitMs` defaults to the user-path wait; best-effort callers (the
   * poll-path marker sync) pass 0 so a held lock skips the sync instead
   * of stalling a UI repaint behind it.
   */
  setActive(accountId: string | null, waitMs: number = this.#writeLockWaitMs): void {
    const result = this.#withMutationLock(waitMs, () => {
      this.#writeRegistry({ ...this.#readRegistry(), activeAccountId: accountId });
      return 'updated';
    });
    if (result === 'busy') {
      throw new VaultError(
        'another credential operation is holding the vault lock — try again in a moment',
      );
    }
  }

  setAlias(accountId: string, alias: string | null): VaultEntry {
    let updatedEntry: VaultEntry | null = null;
    this.#requireMutationLock(() => {
      const registry = this.#readRegistry();
      const entry = registry.accounts[accountId];
      if (entry === undefined) {
        throw new VaultError(`no stored account with id ${accountId}`);
      }
      const normalized = alias === null ? null : normalizeAlias(alias);
      if (
        normalized !== null &&
        Object.entries(registry.accounts).some(
          ([id, other]) => id !== accountId && other.alias === normalized,
        )
      ) {
        throw new VaultError(`alias "${normalized}" is already used by another account`);
      }
      const updated = { ...entry, alias: normalized };
      this.#writeRegistry({
        ...registry,
        accounts: { ...registry.accounts, [accountId]: updated },
      });
      updatedEntry = { accountId, ...updated };
    });
    if (updatedEntry === null) {
      throw new VaultError(`no stored account with id ${accountId}`);
    }
    return updatedEntry;
  }

  /** Lock wrapper for void mutations; a busy lock fails loudly. */
  #requireMutationLock(mutate: () => void): void {
    const result = this.#withMutationLock(this.#writeLockWaitMs, () => {
      mutate();
      return 'updated';
    });
    if (result === 'busy') {
      throw new VaultError(
        'another credential operation is holding the vault lock — try again in a moment',
      );
    }
  }

  /**
   * Preserves credentials we cannot attribute to a stored account
   * instead of overwriting somebody's backup with them. Write-only: the
   * stash is evidence for the user, never consumed automatically.
   */
  stashUnclaimed(credentialsText: string, reason: string, nowUtc: number): string {
    this.#ensureDir();
    const dir = join(this.#dir, 'unclaimed');
    mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
    chmodSync(dir, DIRECTORY_MODE);
    const id = `${nowUtc}-${Bun.randomUUIDv7().slice(0, 8)}`;
    writeFilePrivate(
      join(dir, `${id}.cred`),
      Buffer.from(credentialsText, 'utf8').toString('base64'),
    );
    writeFilePrivate(
      join(dir, `${id}.json`),
      `${JSON.stringify({ id, reason, createdAtUtc: nowUtc }, null, 2)}\n`,
    );
    return id;
  }

  /**
   * Keychain item name. claude-code keeps the historical `claude:`
   * prefix so existing items stay readable; every other agent uses its
   * own name, which also keeps two agents from colliding on an id.
   */
  #keychainAccount(agent: string, accountId: string): string {
    const prefix = agent === 'claude-code' ? 'claude' : assertSafeAccountId(agent);
    return `${prefix}:${assertSafeAccountId(accountId)}`;
  }

  /** Agent for an id we only know from the registry; claude by default. */
  #agentFor(accountId: string): string {
    return this.#readRegistry().accounts[accountId]?.agent ?? 'claude-code';
  }

  #credentialPath(accountId: string): string {
    return join(this.#dir, `${assertSafeAccountId(accountId)}.cred`);
  }

  #readCredentialFile(accountId: string): string | null {
    try {
      const text = readFileSync(this.#credentialPath(accountId), 'utf8').trim();
      return text.length === 0 ? null : text;
    } catch {
      return null;
    }
  }

  #registryPath(): string {
    return join(this.#dir, 'registry.json');
  }

  #ensureDir(): void {
    mkdirSync(this.#dir, { recursive: true, mode: DIRECTORY_MODE });
    chmodSync(this.#dir, DIRECTORY_MODE);
  }

  #readRegistry(): RegistryFile {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asObject(JSON.parse(readFileSync(this.#registryPath(), 'utf8')));
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      return { version: REGISTRY_VERSION, activeAccountId: null, accounts: {} };
    }
    const accounts: Record<string, Omit<VaultEntry, 'accountId'>> = {};
    const raw = asObject(parsed.accounts) ?? {};
    for (const [accountId, value] of Object.entries(raw)) {
      const entry = asObject(value);
      if (entry === null) {
        continue;
      }
      const addedAtUtc = entry.addedAtUtc;
      const refreshDeadAtUtc = entry.refreshDeadAtUtc;
      accounts[accountId] = {
        agent: asString(entry.agent) ?? 'claude-code',
        email: asString(entry.email),
        organizationUuid: asString(entry.organizationUuid),
        organizationName: asString(entry.organizationName),
        alias: asString(entry.alias),
        addedAtUtc: typeof addedAtUtc === 'number' && Number.isFinite(addedAtUtc) ? addedAtUtc : 0,
        backend: entry.backend === 'keychain' ? 'keychain' : 'file',
        // additive field: absent or malformed in older registries → null
        refreshDeadAtUtc:
          typeof refreshDeadAtUtc === 'number' &&
          Number.isFinite(refreshDeadAtUtc) &&
          refreshDeadAtUtc >= 0
            ? refreshDeadAtUtc
            : null,
      };
    }
    return {
      version: REGISTRY_VERSION,
      activeAccountId: asString(parsed.activeAccountId),
      accounts,
    };
  }

  #writeRegistry(registry: RegistryFile): void {
    this.#ensureDir();
    writeFilePrivate(this.#registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
  }
}

/** Directories the vault owns, for doctor's privacy checks. */
export function vaultPaths(dir: string): readonly string[] {
  const paths: string[] = [dir];
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        paths.push(path);
      }
    }
  } catch {
    // no vault yet
  }
  return paths;
}
