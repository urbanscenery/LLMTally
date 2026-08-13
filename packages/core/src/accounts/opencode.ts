/**
 * OpenCode account capture and switching. OpenCode keeps every provider
 * credential in one file — `${XDG_DATA_HOME:-~/.local/share}/opencode/
 * auth.json`, a map of provider id → credential (`api` key or `oauth`
 * tokens) — so a "login" here is the whole credential set and a switch
 * is a swap of that file, exactly like Codex.
 *
 * Unlike Claude Code or Codex the file carries no account identity (no
 * email, no uuid), so the identity is derived: the sorted provider
 * names plus a short fingerprint of the credential lineage —
 * `cline-pass.opencode-go.3f2a9c`. Lineage follows what survives
 * rotation (oauth refresh token, api key), so an oauth access-token
 * refresh does not spawn a "new" account. The same re-read CAS as the
 * Codex switch guards against OpenCode rewriting the file mid-swap.
 */
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';
import { writeFilePrivate } from '../fs/atomic.ts';
import type { AccountVault, VaultEntry } from './vault.ts';

/** Anything that could break out of an HTTP header value. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class OpencodeAccountError extends Error {
  override readonly name = 'OpencodeAccountError';
}

export const OPENCODE_AGENT = 'opencode';

export function defaultOpencodeAuthPath(home: string = homedir()): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.startsWith('/') ? xdg : join(home, '.local', 'share');
  return join(base, 'opencode', 'auth.json');
}

/**
 * The credential-bearing fields across OpenCode's auth shapes: api
 * (`key`), oauth (`access`/`refresh`), wellknown (`key`/`token`). A
 * usable provider must carry a real secret in one of these — not just a
 * `type` discriminator or metadata like `accountId`/`enterpriseUrl` —
 * otherwise it derives an identity and captures as an account whose
 * credentials cannot be spent. The value is trimmed, so a whitespace-only
 * secret does not qualify either.
 */
const OPENCODE_CREDENTIAL_FIELDS = ['key', 'access', 'refresh', 'token'] as const;

function hasCredentialMaterial(entry: Record<string, unknown>): boolean {
  return OPENCODE_CREDENTIAL_FIELDS.some((field) => {
    const value = entry[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function parseProviders(text: string): Map<string, Record<string, unknown>> | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asObject(JSON.parse(text));
  } catch {
    return null;
  }
  if (parsed === null) {
    return null;
  }
  const providers = new Map<string, Record<string, unknown>>();
  for (const [provider, value] of Object.entries(parsed)) {
    const entry = asObject(value);
    if (entry !== null && hasCredentialMaterial(entry)) {
      providers.set(provider, entry);
    }
  }
  return providers.size === 0 ? null : providers;
}

/** Provider ids in a credential file, sorted; empty when unusable. */
export function readOpencodeProviders(text: string): readonly string[] {
  const providers = parseProviders(text);
  return providers === null ? [] : [...providers.keys()].sort();
}

/**
 * The API key one provider stores in an auth.json text, or null when
 * that provider is absent or authenticates some other way (oauth). The
 * exact provider id is required — no prefix or fuzzy matching, so a
 * look-alike entry can never be spent against another vendor.
 */
export function readOpencodeApiKey(text: string, providerId: string): string | null {
  const entry = parseProviders(text)?.get(providerId);
  if (entry === undefined || entry.type !== 'api') {
    return null;
  }
  const key = asString(entry.key);
  // a key leaves as a request header: a stray newline in the credential
  // file would otherwise become header injection on the way out
  if (key === null || key.length === 0 || CONTROL_CHARACTERS.test(key)) {
    return null;
  }
  return key;
}

/**
 * Lineage fingerprint: per provider, the credential part that survives
 * routine rotation — oauth refresh token, api key — hashed over the
 * sorted provider list. Unknown shapes fall back to the entry's JSON.
 */
export function opencodeCredentialFingerprint(text: string): string {
  const providers = parseProviders(text);
  if (providers === null) {
    return `sha256-full:${new Bun.CryptoHasher('sha256').update(text).digest('hex')}`;
  }
  const hasher = new Bun.CryptoHasher('sha256');
  for (const provider of [...providers.keys()].sort()) {
    const entry = providers.get(provider) ?? {};
    const lineage =
      asString(entry.refresh) ?? asString(entry.key) ?? JSON.stringify(entry);
    hasher.update(`${provider}\u0000${lineage}\u0000`);
  }
  return `sha256:${hasher.digest('hex')}`;
}

/**
 * Derived identity: `<providers>.<fp6>`. Provider names are sanitized
 * to the vault's account-id charset; the fingerprint suffix separates
 * two credential sets that happen to cover the same providers.
 */
/**
 * Best-effort display email from oauth tokens in the bundle. API keys
 * (opencode-go) carry no identity, and Go's usage endpoint has none
 * either. A JWT `email` claim on some other oauth provider is the only
 * local signal. Missing is normal, not an error.
 */
function tokenEmail(token: string | null): string | null {
  if (token === null) {
    return null;
  }
  const payload = token.split('.')[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const body = asObject(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    const email = body === null ? null : asString(body.email);
    return email !== null && email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

export function readOpencodeDisplayEmail(text: string): string | null {
  const providers = parseProviders(text);
  if (providers === null) {
    return null;
  }
  for (const entry of providers.values()) {
    for (const field of ['id_token', 'idToken', 'access', 'token'] as const) {
      const email = tokenEmail(asString(entry[field] ?? null));
      if (email !== null) {
        return email;
      }
    }
  }
  return null;
}

export function formatOpencodeAccountLabel(
  accountId: string,
  alias: string | null,
  email: string | null,
): string {
  const base = email ?? accountId;
  return alias === null ? base : `${base} [${alias}]`;
}

export function opencodeAccountId(text: string): string {
  const providers = readOpencodeProviders(text)
    .map((provider) => provider.replace(/[^A-Za-z0-9._-]/g, '_'))
    .join('.');
  const fingerprint = opencodeCredentialFingerprint(text);
  const short = fingerprint.slice(fingerprint.indexOf(':') + 1, fingerprint.indexOf(':') + 7);
  // the whole id must fit the vault charset and its 128-char cap
  return `${providers}.${short}`.slice(0, 128);
}

/** Per-provider lineage (refresh token, else api key, else the entry). */
function providerLineages(text: string): Map<string, string> | null {
  const providers = parseProviders(text);
  if (providers === null) {
    return null;
  }
  const lineages = new Map<string, string>();
  for (const [provider, entry] of providers) {
    lineages.set(provider, asString(entry.refresh) ?? asString(entry.key) ?? JSON.stringify(entry));
  }
  return lineages;
}

/**
 * True when `stored` is the same login as `live` before a provider was
 * added: every stored provider is still in live with the same lineage,
 * but the derived account ids differ. A stored *superset* is not a
 * predecessor — that is a switchable fuller set, not a stale snapshot.
 */
export function isOpencodeProviderPredecessor(stored: string, live: string): boolean {
  const storedLineages = providerLineages(stored);
  const liveLineages = providerLineages(live);
  if (storedLineages === null || liveLineages === null || storedLineages.size === 0) {
    return false;
  }
  if (opencodeAccountId(stored) === opencodeAccountId(live)) {
    return false;
  }
  for (const [provider, lineage] of storedLineages) {
    if (liveLineages.get(provider) !== lineage) {
      return false;
    }
  }
  return true;
}

export type OpencodeLiveSyncOutcome = 'not_needed' | 'retired' | 'unavailable';

/**
 * When the live auth.json grew a provider, the derived account id
 * changes and the previous vault row would otherwise sit next to it as
 * a second "account". The old row is the same login, so it is removed
 * and the live bytes are stored under the new id (alias preserved).
 */
export function syncOpencodeLiveIdentity(ports: {
  readonly vault: AccountVault;
  readonly authPath?: string;
  readonly nowUtc?: number;
}): OpencodeLiveSyncOutcome {
  const authPath = ports.authPath ?? defaultOpencodeAuthPath();
  const live = readAuthFile(authPath);
  if (live === null || readOpencodeProviders(live).length === 0) {
    return 'unavailable';
  }
  return retireOpencodePredecessors(ports.vault, live, ports.nowUtc);
}

function listOpencodePredecessors(vault: AccountVault, live: string): VaultEntry[] {
  const liveId = opencodeAccountId(live);
  const predecessors: VaultEntry[] = [];
  for (const entry of vault.list()) {
    if (entry.agent !== OPENCODE_AGENT || entry.accountId === liveId) {
      continue;
    }
    let stored: string | null;
    try {
      stored = vault.loadCredentials(OPENCODE_AGENT, entry.accountId);
    } catch {
      continue;
    }
    if (stored !== null && isOpencodeProviderPredecessor(stored, live)) {
      predecessors.push(entry);
    }
  }
  return predecessors;
}

/** Prefer a named row, then the oldest — that is the original capture. */
function pickPredecessorDonor(predecessors: readonly VaultEntry[]): VaultEntry | null {
  const named = predecessors.find((entry) => entry.alias !== null);
  if (named !== undefined) {
    return named;
  }
  return predecessors.reduce<VaultEntry | null>(
    (oldest, entry) => (oldest === null || entry.addedAtUtc < oldest.addedAtUtc ? entry : oldest),
    null,
  );
}

function retireOpencodePredecessors(
  vault: AccountVault,
  live: string,
  nowUtc?: number,
): OpencodeLiveSyncOutcome {
  const predecessors = listOpencodePredecessors(vault, live);
  if (predecessors.length === 0) {
    return 'not_needed';
  }

  const liveId = opencodeAccountId(live);
  const existing = vault.get(OPENCODE_AGENT, liveId);
  const donor = pickPredecessorDonor(predecessors);
  try {
    vault.put(
      {
        agent: OPENCODE_AGENT,
        accountId: liveId,
        email: existing?.email ?? donor?.email ?? readOpencodeDisplayEmail(live),
        organizationUuid: null,
        organizationName: readOpencodeProviders(live).join(', '),
        alias: existing?.alias ?? donor?.alias ?? null,
        addedAtUtc: existing?.addedAtUtc ?? donor?.addedAtUtc ?? nowUtc ?? Math.floor(Date.now() / 1000),
        refreshDeadAtUtc: existing?.refreshDeadAtUtc ?? null,
      },
      live,
    );
    for (const entry of predecessors) {
      vault.remove(OPENCODE_AGENT, entry.accountId);
    }
  } catch {
    return 'unavailable';
  }
  return 'retired';
}

function readAuthFile(authPath: string): string | null {
  try {
    const text = readFileSync(authPath, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** Snapshot of the OpenCode credential set that is active right now. */
export function captureOpencodeAccount(ports: {
  readonly vault: AccountVault;
  readonly authPath?: string;
  readonly alias?: string | null;
  readonly nowUtc?: number;
}): VaultEntry {
  const authPath = ports.authPath ?? defaultOpencodeAuthPath();
  const live = readAuthFile(authPath);
  const providers = live === null ? [] : readOpencodeProviders(live);
  if (live === null || providers.length === 0) {
    throw new OpencodeAccountError(
      `no usable OpenCode credentials found in ${authPath} — run "opencode auth login" first`,
    );
  }
  const accountId = opencodeAccountId(live);
  const existing = ports.vault.get(OPENCODE_AGENT, accountId);
  const donor = pickPredecessorDonor(listOpencodePredecessors(ports.vault, live));
  const entry = ports.vault.put(
    {
      agent: OPENCODE_AGENT,
      accountId,
      email: existing?.email ?? donor?.email ?? readOpencodeDisplayEmail(live),
      organizationUuid: null,
      organizationName: providers.join(', '),
      alias:
        ports.alias === undefined ? (existing?.alias ?? donor?.alias ?? null) : ports.alias,
      addedAtUtc:
        existing?.addedAtUtc ?? donor?.addedAtUtc ?? ports.nowUtc ?? Math.floor(Date.now() / 1000),
      refreshDeadAtUtc: null,
    },
    live,
  );
  // a provider added to the same login changes the derived id; the
  // previous row is the same credential set, not a second account
  retireOpencodePredecessors(ports.vault, live, ports.nowUtc);
  return ports.vault.get(OPENCODE_AGENT, accountId) ?? entry;
}

/** Resolves an id or alias — among opencode entries only. */
function resolveOpencodeEntry(vault: AccountVault, selector: string): VaultEntry {
  const entries = vault.list().filter((entry) => entry.agent === OPENCODE_AGENT);
  const byId = entries.find((entry) => entry.accountId === selector);
  if (byId !== undefined) {
    return byId;
  }
  const lowered = selector.trim().toLowerCase();
  const byAlias = entries.filter((entry) => entry.alias === lowered);
  if (byAlias.length === 1 && byAlias[0] !== undefined) {
    return byAlias[0];
  }
  throw new OpencodeAccountError(`no stored opencode credential set matches "${selector}"`);
}

export type OpencodeOutgoingKind = 'own' | 'unclaimed' | 'absent';

export interface OpencodeSwitchResult {
  readonly target: VaultEntry;
  readonly outgoing: OpencodeOutgoingKind;
  readonly warnings: readonly string[];
}

export async function switchOpencodeAccount(
  selector: string,
  ports: {
    readonly vault: AccountVault;
    readonly authPath?: string;
    readonly nowUtc?: number;
    /** Test seam: runs between the CAS re-read and the rename. */
    readonly beforeWrite?: () => void;
  },
): Promise<OpencodeSwitchResult> {
  const authPath = ports.authPath ?? defaultOpencodeAuthPath();
  const now = ports.nowUtc ?? Math.floor(Date.now() / 1000);
  const { vault } = ports;

  const target = resolveOpencodeEntry(vault, selector);
  const targetCredentials = vault.loadCredentials(OPENCODE_AGENT, target.accountId);
  if (targetCredentials === null) {
    throw new OpencodeAccountError(
      `no stored credentials for ${target.accountId} — press n while that set is active`,
    );
  }

  const warnings: string[] = [];
  const live = readAuthFile(authPath);
  if (live !== null && opencodeCredentialFingerprint(live) === opencodeCredentialFingerprint(targetCredentials)) {
    warnings.push(`${target.alias ?? target.accountId} is already the active opencode credential set`);
    return { target, outgoing: 'absent', warnings };
  }

  // preserve the outgoing credential set before anything is overwritten
  let outgoing: OpencodeOutgoingKind = 'absent';
  if (live !== null) {
    const fingerprint = opencodeCredentialFingerprint(live);
    const owner = vault
      .list()
      .filter((entry) => entry.agent === OPENCODE_AGENT)
      .find((entry) => {
        // an unreadable third account reads as "no match", not a veto:
        // the outgoing credential set is still captured/stashed below
        let stored: string | null;
        try {
          stored = vault.loadCredentials(OPENCODE_AGENT, entry.accountId);
        } catch {
          return false;
        }
        return stored !== null && opencodeCredentialFingerprint(stored) === fingerprint;
      });
    if (owner !== undefined) {
      outgoing = 'own';
      const { backend: _backend, ...rest } = owner;
      vault.put({ ...rest, refreshDeadAtUtc: null }, live);
    } else if (readOpencodeProviders(live).length > 0) {
      // an identity is always derivable here, so an unknown set becomes
      // its own entry rather than a write-only stash
      outgoing = 'unclaimed';
      const liveId = opencodeAccountId(live);
      vault.put(
        {
          agent: OPENCODE_AGENT,
          accountId: liveId,
          email: readOpencodeDisplayEmail(live),
          organizationUuid: null,
          organizationName: readOpencodeProviders(live).join(', '),
          alias: null,
          addedAtUtc: now,
          refreshDeadAtUtc: null,
        },
        live,
      );
      warnings.push(`the live opencode credentials were not stored; captured them as ${liveId}`);
    } else {
      outgoing = 'unclaimed';
      const stashId = vault.stashUnclaimed(live, 'unreadable opencode credentials before switch', now);
      warnings.push(`the live opencode credentials were unreadable; kept a copy as unclaimed/${stashId}`);
    }
  }

  // re-read CAS: abort if OpenCode rewrote the file while we worked
  ports.beforeWrite?.();
  const recheck = readAuthFile(authPath);
  if (recheck !== live) {
    throw new OpencodeAccountError(
      'auth.json changed while switching (opencode rewrote it) — try again',
    );
  }

  const staging = join(
    dirname(authPath),
    `.auth.json.llmtally.${process.pid}.${Bun.randomUUIDv7().slice(-8)}`,
  );
  writeFilePrivate(staging, targetCredentials);
  try {
    renameSync(staging, authPath);
  } catch (error) {
    rmSync(staging, { force: true });
    throw new OpencodeAccountError(
      `could not activate the opencode credentials: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  warnings.push('a running opencode session keeps its old credentials until restarted');
  return { target, outgoing, warnings };
}
