/**
 * llmtally's own account store, the thing that makes switching possible
 * at all. Layout under `~/.llmtally/accounts` (0700):
 *
 *   registry.json               labels + which account is active per agent
 *   <agent>--<accountId>.cred   base64 credentials (file backend)
 *   unclaimed/<id>.cred         credentials we could not attribute, kept
 *                               with a manifest instead of being destroyed
 *
 * On macOS the credentials live in the Keychain (service `llmtally`,
 * account `<agent>:<accountId>`) and the `.cred` file is absent; the
 * file backend is the fallback when no Keychain is available. Secrets
 * are base64 so a Keychain item is always a single safe line — that is
 * encoding, not encryption.
 *
 * Every store keys on `(agent, accountId)`: two agents may legitimately
 * produce the same account id (both are vendor-issued namespaces), and
 * a single-id registry let the later agent silently overwrite the
 * earlier one's entry while orphaning its Keychain item. Registries
 * written by the accountId-keyed format (version 1) are read
 * transparently and converge to version 2 on the first mutation.
 */
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';
import { credentialFingerprint, writeFilePrivate } from './credentials.ts';
import { macosKeychain } from './keychain.ts';
import type { KeychainPort } from './keychain.ts';

export const VAULT_KEYCHAIN_SERVICE = 'llmtally';
const DIRECTORY_MODE = 0o700;
const REGISTRY_VERSION = 2;
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
  /** Which agent this login belongs to (claude-code, codex, opencode…). */
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
  /** Active account per agent; a v1 file carried one global marker. */
  readonly active: Readonly<Record<string, string | null>>;
  /** Keyed `<agent>:<accountId>`; the entry also carries both fields. */
  readonly accounts: Readonly<Record<string, VaultEntry>>;
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
/**
 * Agent names are internal constants, but the registry is a plain file:
 * a tampered agent value must not escape the vault directory either.
 * `--` is excluded so `<agent>--<accountId>.cred` parses one way only.
 */
const AGENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function assertSafeAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || accountId.includes('..')) {
    throw new VaultError(
      `refusing to use account id "${accountId}" — expected a uuid or address (letters, digits, ".", "_", "@", "-")`,
    );
  }
  return accountId;
}

export function assertSafeAgent(agent: string): string {
  if (!AGENT_PATTERN.test(agent) || agent.includes('--')) {
    throw new VaultError(
      `refusing to use agent name "${agent}" — expected lowercase letters, digits and single "-"`,
    );
  }
  return agent;
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
    return Object.values(this.#readRegistry().accounts);
  }

  activeAccountId(agent: string): string | null {
    return this.#readRegistry().active[agent] ?? null;
  }

  get(agent: string, accountId: string): VaultEntry | null {
    return this.#readRegistry().accounts[keyFor(agent, accountId)] ?? null;
  }

  /**
   * Resolves an account id, alias, or email among one agent's entries.
   * An email that matches more than one account is rejected rather than
   * guessed — the same address can belong to both a personal and an
   * organization account.
   */
  resolve(agent: string, selector: string): VaultEntry {
    const entries = this.list().filter((entry) => entry.agent === agent);
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
    assertSafeAgent(entry.agent);
    assertSafeAccountId(entry.accountId);
    this.#ensureDir();
    // read (and thereby validate) the registry BEFORE the secret moves:
    // a corrupt registry must abort the whole put while the Keychain
    // and credential file are still untouched (audit codex C1-01)
    const registry = this.#readRegistry();
    const encoded = Buffer.from(credentialsText, 'utf8').toString('base64');
    let backend: VaultEntry['backend'] = 'file';
    if (this.#keychain.available) {
      const keychainAccount = this.#keychainAccount(entry.agent, entry.accountId);
      try {
        this.#keychain.write(VAULT_KEYCHAIN_SERVICE, keychainAccount, encoded);
        backend = 'keychain';
      } catch (error) {
        // falling back to a file is only safe when the Keychain provably
        // holds nothing: reads prefer the Keychain, so a row we could
        // neither replace nor remove would shadow the fresher file copy
        // with stale bytes the moment the keychain answers again
        try {
          this.#keychain.remove(VAULT_KEYCHAIN_SERVICE, keychainAccount);
        } catch {
          // verified by the read below; an uncleared row fails the write
        }
        if (this.#keychain.read(VAULT_KEYCHAIN_SERVICE, keychainAccount).kind !== 'absent') {
          throw new VaultError(
            `keychain write failed and the existing item could not be cleared (${
              error instanceof Error ? error.message : String(error)
            }) — nothing was changed`,
          );
        }
        backend = 'file';
      }
    }
    if (backend === 'file') {
      writeFilePrivate(this.#credentialPath(entry.agent, entry.accountId), encoded);
    } else {
      // a stale plaintext copy must not outlive a successful Keychain write
      rmSync(this.#credentialPath(entry.agent, entry.accountId), { force: true });
    }
    this.#retireLegacyFile(registry, entry.agent, entry.accountId);
    const key = keyFor(entry.agent, entry.accountId);
    const refreshDeadAtUtc =
      entry.refreshDeadAtUtc !== undefined
        ? entry.refreshDeadAtUtc
        : (registry.accounts[key]?.refreshDeadAtUtc ?? null);
    const stored: VaultEntry = { ...entry, backend, refreshDeadAtUtc };
    this.#writeRegistry({
      ...registry,
      accounts: { ...registry.accounts, [key]: stored },
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
    agent: string,
    accountId: string,
    expectedFingerprint: string,
    nowUtc: number,
  ): VaultCredentialMutation {
    return this.#withMutationLock(MARK_DEAD_LOCK_WAIT_MS, () => {
      const registry = this.#readRegistry();
      const key = keyFor(agent, accountId);
      const entry = registry.accounts[key];
      const current = this.loadCredentials(agent, accountId);
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
          [key]: { ...entry, refreshDeadAtUtc: nowUtc },
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
    agent: string,
    accountId: string,
    expectedFingerprint: string,
    credentialsText: string,
    options: { readonly clearRefreshDead: boolean },
  ): VaultCredentialMutation {
    return this.#withMutationLock(REPLACE_LOCK_WAIT_MS, () => {
      const entry = this.get(agent, accountId);
      const current = this.loadCredentials(agent, accountId);
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
    } catch (error) {
      // an unopenable lock file is an environment fault, not contention:
      // reporting it as 'busy' made callers silently drop a rotated
      // refresh token and later quarantine the account (audit GK-18)
      throw new VaultError(
        `cannot open the vault mutation lock (${lockPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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

  /**
   * null means confirmed absent. A keychain that cannot answer throws
   * `VaultError` — "unknown" must never masquerade as "no credentials",
   * or a poll quarantines and a switch refuses a perfectly stored login.
   */
  loadCredentials(agent: string, accountId: string): string | null {
    let encoded: string | null = null;
    if (this.#keychain.available) {
      const result = this.#keychain.read(
        VAULT_KEYCHAIN_SERVICE,
        this.#keychainAccount(agent, accountId),
      );
      if (result.kind === 'error') {
        throw new VaultError(`stored credentials are unreadable right now (${result.message})`);
      }
      if (result.kind === 'found') {
        encoded = result.value;
      }
    }
    encoded ??= this.#readCredentialFile(agent, accountId);
    if (encoded === null) {
      return null;
    }
    try {
      return Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  remove(agent: string, accountId: string): void {
    // registry + credential removal is a mutation like any other: an
    // unlocked read-modify-write here could resurrect the account by
    // racing a CAS that re-writes the registry from its earlier read
    this.#requireMutationLock(() => {
      // registry first: a corrupt registry must abort BEFORE the only
      // copy of the secret is destroyed (audit codex C2-05)
      const registry = this.#readRegistry();
      this.#keychain.remove(VAULT_KEYCHAIN_SERVICE, this.#keychainAccount(agent, accountId));
      rmSync(this.#credentialPath(agent, accountId), { force: true });
      this.#retireLegacyFile(registry, agent, accountId);
      const { [keyFor(agent, accountId)]: removed, ...remaining } = registry.accounts;
      this.#writeRegistry({
        ...registry,
        active:
          registry.active[agent] === accountId
            ? { ...registry.active, [agent]: null }
            : registry.active,
        accounts: remaining,
      });
    });
  }

  /**
   * `waitMs` defaults to the user-path wait; best-effort callers (the
   * poll-path marker sync) pass 0 so a held lock skips the sync instead
   * of stalling a UI repaint behind it.
   */
  setActive(agent: string, accountId: string | null, waitMs: number = this.#writeLockWaitMs): void {
    const result = this.#withMutationLock(waitMs, () => {
      const registry = this.#readRegistry();
      this.#writeRegistry({
        ...registry,
        active: { ...registry.active, [agent]: accountId },
      });
      return 'updated';
    });
    if (result === 'busy') {
      throw new VaultError(
        'another credential operation is holding the vault lock — try again in a moment',
      );
    }
  }

  setAlias(agent: string, accountId: string, alias: string | null): VaultEntry {
    let updatedEntry: VaultEntry | null = null;
    this.#requireMutationLock(() => {
      const registry = this.#readRegistry();
      const key = keyFor(agent, accountId);
      const entry = registry.accounts[key];
      if (entry === undefined) {
        throw new VaultError(`no stored account with id ${accountId}`);
      }
      const normalized = alias === null ? null : normalizeAlias(alias);
      if (
        normalized !== null &&
        Object.values(registry.accounts).some(
          (other) =>
            other.agent === agent && other.accountId !== accountId && other.alias === normalized,
        )
      ) {
        throw new VaultError(`alias "${normalized}" is already used by another account`);
      }
      const updated = { ...entry, alias: normalized };
      this.#writeRegistry({
        ...registry,
        accounts: { ...registry.accounts, [key]: updated },
      });
      updatedEntry = updated;
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
    const prefix = agent === 'claude-code' ? 'claude' : assertSafeAgent(agent);
    return `${prefix}:${assertSafeAccountId(accountId)}`;
  }

  #credentialPath(agent: string, accountId: string): string {
    return join(this.#dir, `${assertSafeAgent(agent)}--${assertSafeAccountId(accountId)}.cred`);
  }

  /** Pre-v2 file name; still read so a v1 vault works before it migrates. */
  #legacyCredentialPath(accountId: string): string {
    return join(this.#dir, `${assertSafeAccountId(accountId)}.cred`);
  }

  /**
   * Retires the pre-v2 `<accountId>.cred` file on the first credential
   * mutation that touches its account id. v1 could not say which agent
   * the bytes belong to, so they are first copied to the qualified path
   * of every OTHER agent sharing the id that has no qualified file yet
   * (preserving exactly what a fallback read would have returned), and
   * only then is the ambiguous name deleted — a removed account's
   * secret must not survive under a name any agent can still read.
   */
  #retireLegacyFile(registry: RegistryFile, mutatingAgent: string, accountId: string): void {
    const legacyPath = this.#legacyCredentialPath(accountId);
    let encoded: string | null;
    try {
      const text = readFileSync(legacyPath, 'utf8').trim();
      encoded = text.length === 0 ? null : text;
    } catch {
      return;
    }
    if (encoded !== null) {
      for (const other of Object.values(registry.accounts)) {
        if (other.accountId !== accountId || other.agent === mutatingAgent) {
          continue;
        }
        const qualified = this.#credentialPath(other.agent, other.accountId);
        if (!existsSync(qualified)) {
          writeFilePrivate(qualified, encoded);
        }
      }
    }
    rmSync(legacyPath, { force: true });
  }

  #readCredentialFile(agent: string, accountId: string): string | null {
    for (const path of [
      this.#credentialPath(agent, accountId),
      this.#legacyCredentialPath(accountId),
    ]) {
      try {
        const text = readFileSync(path, 'utf8').trim();
        if (text.length > 0) {
          return text;
        }
      } catch {
        // fall through to the older name
      }
    }
    return null;
  }

  #registryPath(): string {
    return join(this.#dir, 'registry.json');
  }

  #ensureDir(): void {
    mkdirSync(this.#dir, { recursive: true, mode: DIRECTORY_MODE });
    chmodSync(this.#dir, DIRECTORY_MODE);
  }

  /**
   * Reads either registry format into the canonical v2 shape. A v1 file
   * (accounts keyed by accountId alone, one global active marker) is
   * converted in memory only — read paths must stay write-free — and
   * the first mutation persists the converted form.
   */
  #readRegistry(): RegistryFile {
    // Fail closed on a corrupt registry: an unreadable-but-present file
    // must never look like an empty vault, because the next mutation
    // would atomically replace it and destroy every account's metadata
    // (aliases, active markers, keychain pointers). Only a missing file
    // is an empty vault.
    let text: string;
    try {
      text = readFileSync(this.#registryPath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: REGISTRY_VERSION, active: {}, accounts: {} };
      }
      throw new VaultError(
        `account registry is unreadable (${this.#registryPath()}): ${
          error instanceof Error ? error.message : String(error)
        } — fix or move the file; refusing to treat it as empty`,
      );
    }
    let parsed: Record<string, unknown> | null;
    try {
      parsed = asObject(JSON.parse(text));
    } catch (error) {
      throw new VaultError(
        `account registry is corrupt (${this.#registryPath()}): ${
          error instanceof Error ? error.message : String(error)
        } — fix or move the file; refusing to treat it as empty`,
      );
    }
    if (parsed === null) {
      throw new VaultError(
        `account registry is not an object (${this.#registryPath()}) — fix or move the file; refusing to treat it as empty`,
      );
    }
    const isV2 = parsed.version === REGISTRY_VERSION;
    const accounts: Record<string, VaultEntry> = {};
    // fail closed on shape damage too: an `accounts` that exists but is
    // not an object, or an entry that is not an object, means the file
    // was corrupted — normalizing it away and persisting on the next
    // mutation would erase real account metadata (audit codex C1-02)
    if (asObject(parsed.accounts) === null) {
      // present file, missing/broken accounts map = damage, not empty:
      // every writer always serializes the key (audit codex C3-04)
      throw new VaultError(
        `account registry "accounts" is missing or not an object (${this.#registryPath()}) — fix or move the file`,
      );
    }
    const raw = asObject(parsed.accounts) ?? {};
    for (const [rawKey, value] of Object.entries(raw)) {
      const entry = asObject(value);
      if (entry === null) {
        throw new VaultError(
          `account registry entry "${rawKey}" is not an object (${this.#registryPath()}) — fix or move the file`,
        );
      }
      // v2 stores identity in the entry — silently defaulting a
      // missing agent/id would launder corruption into valid-looking
      // rows the next mutation persists (audit codex C2-08). A v1 key
      // IS the id, and v1 predates the agent field.
      if (isV2 && (asString(entry.agent) === null || asString(entry.accountId) === null)) {
        throw new VaultError(
          `account registry entry "${rawKey}" is missing its agent/accountId (${this.#registryPath()}) — fix or move the file`,
        );
      }
      const agent = asString(entry.agent) ?? 'claude-code';
      const accountId = (isV2 ? asString(entry.accountId) : rawKey) ?? rawKey;
      const addedAtUtc = entry.addedAtUtc;
      const refreshDeadAtUtc = entry.refreshDeadAtUtc;
      accounts[keyFor(agent, accountId)] = {
        agent,
        accountId,
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
      active: readActive(parsed, accounts, isV2),
      accounts,
    };
  }

  #writeRegistry(registry: RegistryFile): void {
    this.#ensureDir();
    writeFilePrivate(this.#registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
  }
}

function keyFor(agent: string, accountId: string): string {
  return `${agent}:${accountId}`;
}

/**
 * The per-agent active map. A v1 file carried a single `activeAccountId`
 * whose agent was implicit; it is attributed to the agent of the entry
 * it names (claude-code when no entry matches — the marker predates
 * every other agent).
 */
function readActive(
  parsed: Record<string, unknown>,
  accounts: Readonly<Record<string, VaultEntry>>,
  isV2: boolean,
): Record<string, string | null> {
  if (isV2) {
    const active: Record<string, string | null> = {};
    for (const [agent, value] of Object.entries(asObject(parsed.active) ?? {})) {
      active[agent] = asString(value);
    }
    return active;
  }
  const marker = asString(parsed.activeAccountId);
  if (marker === null) {
    return {};
  }
  const owner = Object.values(accounts).find((entry) => entry.accountId === marker);
  return { [owner?.agent ?? 'claude-code']: marker };
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
