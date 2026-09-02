/**
 * Identity and credential access for Grok Build's store,
 * `~/.grok/auth.json` — a map of `<oidc_issuer>::<client_id>` to one
 * credential record. Reading identity stays token-free; the credential
 * paths (capture, live-sync, vault polling) carry the tokens but only
 * ever between the live file and llmtally's own vault. The single code
 * that writes back into ~/.grok is the switch (`grok-switch.ts`), the
 * third user-approved exception to the read-only rule (2026-08-17).
 *
 * The vault stores ONE entry per account, as a single-key document
 * `{"<issuer>::<client_id>": record}` — never the whole file, which may
 * carry other issuers' logins that belong to other accounts.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';
import type { AccountVault, VaultEntry } from './vault.ts';

export class GrokAccountError extends Error {
  override readonly name = 'GrokAccountError';
}

export const GROK_AGENT = 'grok';

export interface GrokIdentity {
  /** xAI user uuid — stable across logins, unlike the email. */
  readonly accountId: string;
  readonly email: string | null;
  readonly teamId: string | null;
}

export function defaultGrokAuthPath(home: string): string {
  return join(home, '.grok', 'auth.json');
}

/**
 * auth.json maps `<oidc_issuer>::<client_id>` to one credential record,
 * so a machine signed into two accounts has two entries. Records without
 * a user id are skipped rather than keyed on the email, which is a
 * display concern and may be shared by two accounts.
 */
export function readGrokIdentities(authPath: string): readonly GrokIdentity[] {
  const text = readAuthFile(authPath);
  if (text === null) {
    return [];
  }
  const identities: GrokIdentity[] = [];
  const seen = new Set<string>();
  for (const entry of readGrokAuthEntries(text)) {
    if (entry.accountId === null || seen.has(entry.accountId)) {
      continue;
    }
    seen.add(entry.accountId);
    identities.push({
      accountId: entry.accountId,
      email: entry.email,
      teamId: asString(entry.record.team_id),
    });
  }
  return identities;
}

/** One `<issuer>::<client_id>` slot of auth.json, tokens included. */
export interface GrokAuthEntry {
  readonly entryKey: string;
  /** The record exactly as stored; unknown fields ride along untouched. */
  readonly record: Readonly<Record<string, unknown>>;
  readonly accountId: string | null;
  readonly email: string | null;
  /** Grok stores the access token under `key`. */
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAtUtc: number | null;
}

function parseIsoSeconds(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function toEntry(entryKey: string, record: Record<string, unknown>): GrokAuthEntry {
  return {
    entryKey,
    record,
    accountId: asString(record.user_id),
    email: asString(record.email),
    accessToken: asString(record.key),
    refreshToken: asString(record.refresh_token),
    expiresAtUtc: parseIsoSeconds(record.expires_at),
  };
}

/**
 * Every entry of an auth.json-shaped document — the live file or a
 * vault-stored single-entry copy. Unparseable text reads as empty (the
 * CLI holds `auth.json.lock` while rewriting, so a torn read is a
 * "skip this pass", not an error).
 */
export function readGrokAuthEntries(text: string): readonly GrokAuthEntry[] {
  let document: Record<string, unknown> | null;
  try {
    document = asObject(JSON.parse(text));
  } catch {
    return [];
  }
  if (document === null) {
    return [];
  }
  const entries: GrokAuthEntry[] = [];
  for (const [entryKey, value] of Object.entries(document)) {
    const record = asObject(value);
    if (record !== null) {
      entries.push(toEntry(entryKey, record));
    }
  }
  return entries;
}

/**
 * The one usable entry of a vault-stored credential document. The vault
 * only ever stores single-entry documents, but the stored bytes are
 * still external input: anything without an account id and an access
 * token is unusable, not "the first entry".
 */
export function readStoredGrokEntry(text: string): GrokAuthEntry | null {
  return (
    readGrokAuthEntries(text).find(
      (entry) => entry.accountId !== null && entry.accessToken !== null,
    ) ?? null
  );
}

/** The single-key document shape the vault stores. */
export function serializeGrokEntry(entry: GrokAuthEntry): string {
  return JSON.stringify({ [entry.entryKey]: entry.record });
}

/**
 * Lineage identity for one grok login. xAI rotates the refresh token on
 * every grant, but within one stored generation it is the stable-est
 * field there is — and hashing the token (not the record) makes the
 * fingerprint independent of JSON formatting, which differs between the
 * CLI's file and the vault's compact copy of the same generation.
 */
export function grokEntryFingerprint(entry: GrokAuthEntry): string {
  const basis = entry.refreshToken;
  const hash = new Bun.CryptoHasher('sha256')
    .update(basis ?? JSON.stringify(entry.record))
    .digest('hex');
  return basis !== null ? `sha256:${hash}` : `sha256-full:${hash}`;
}

function readAuthFile(authPath: string): string | null {
  try {
    const text = readFileSync(authPath, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** Live entries that can actually be stored: id + token present. */
export function readCapturableGrokEntries(authPath: string): readonly GrokAuthEntry[] {
  const live = readAuthFile(authPath);
  if (live === null) {
    return [];
  }
  const seen = new Set<string>();
  return readGrokAuthEntries(live).filter((entry) => {
    if (entry.accountId === null || entry.accessToken === null || seen.has(entry.accountId)) {
      return false;
    }
    seen.add(entry.accountId);
    return true;
  });
}

/** Stores one live entry onto its vault slot, preserving entry metadata. */
export function putGrokEntry(
  vault: AccountVault,
  entry: GrokAuthEntry,
  options: { readonly alias?: string | null; readonly nowUtc?: number } = {},
): VaultEntry {
  if (entry.accountId === null) {
    throw new GrokAccountError('refusing to store a grok login without a user id');
  }
  const existing = vault.get(GROK_AGENT, entry.accountId);
  return vault.put(
    {
      agent: GROK_AGENT,
      accountId: entry.accountId,
      email: entry.email,
      organizationUuid: asString(entry.record.team_id),
      organizationName: null,
      alias: options.alias === undefined ? (existing?.alias ?? null) : options.alias,
      addedAtUtc: existing?.addedAtUtc ?? options.nowUtc ?? Math.floor(Date.now() / 1000),
      // a capture is proof of a working login; lift any quarantine
      refreshDeadAtUtc: null,
    },
    serializeGrokEntry(entry),
  );
}

export interface GrokCaptureResult {
  readonly entries: readonly VaultEntry[];
  /** Logins that could not be stored this pass, one line each. */
  readonly failures: readonly string[];
}

/**
 * Snapshot of every grok login active right now. Unlike codex the file
 * can hold several entries (one per issuer::client), and none of them
 * revokes another, so all of them are captured in one press. A store
 * that fails mid-way must not report the already-persisted accounts as
 * failed too: successes and failures are returned side by side, and
 * only a capture that stored NOTHING throws.
 */
export function captureGrokAccounts(ports: {
  readonly vault: AccountVault;
  readonly authPath?: string;
  readonly nowUtc?: number;
}): GrokCaptureResult {
  const authPath = ports.authPath ?? defaultGrokAuthPath(homedir());
  const liveEntries = readCapturableGrokEntries(authPath);
  if (liveEntries.length === 0) {
    throw new GrokAccountError(
      `no usable Grok login found in ${authPath} — run "grok" and sign in first`,
    );
  }
  const entries: VaultEntry[] = [];
  const failures: string[] = [];
  for (const entry of liveEntries) {
    try {
      entries.push(putGrokEntry(ports.vault, entry, { nowUtc: ports.nowUtc }));
    } catch (error) {
      failures.push(
        `${entry.email ?? entry.accountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (entries.length === 0) {
    throw new GrokAccountError(`could not store any Grok login — ${failures.join('; ')}`);
  }
  return { entries, failures };
}
