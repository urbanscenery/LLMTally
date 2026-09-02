/**
 * Identity and credential access for Cursor Agent CLI.
 *
 * The selected account lives in `~/.cursor/cli-config.json` (`authInfo`);
 * the tokens live in the macOS Keychain (or `~/.cursor/auth.json` when
 * `AGENT_CLI_CREDENTIAL_STORE=file`). Identity reads stay token-free.
 * The only writer into those stores is the switch
 * (`cursor-cli-switch.ts`), the fourth user-approved exception to the
 * read-only rule.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CURSOR_CLI_AGENT } from '../parsers/cursor-cli/constants.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { macosKeychain } from './keychain.ts';
import type { KeychainPort, KeychainReadResult } from './keychain.ts';
import type { AccountVault, VaultEntry } from './vault.ts';

export class CursorCliAccountError extends Error {
  override readonly name = 'CursorCliAccountError';
}

export { CURSOR_CLI_AGENT };

const KEYCHAIN_ACCOUNT = 'cursor-user';
const ACCESS_SERVICE = 'cursor-access-token';
const REFRESH_SERVICE = 'cursor-refresh-token';
const API_KEY_SERVICE = 'cursor-api-key';

export function defaultCursorCliConfigPath(home: string): string {
  return join(home, '.cursor', 'cli-config.json');
}

export function defaultCursorCliAuthPath(home: string): string {
  return join(home, '.cursor', 'auth.json');
}

export function defaultCursorCliLockPath(home: string): string {
  return `${defaultCursorCliConfigPath(home)}.lock`;
}

export interface CursorCliIdentity {
  /** Decimal string of `authInfo.userId`. Never `authId`. */
  readonly accountId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly authId: string | null;
}

export interface CursorCliCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly apiKey: string | null;
  readonly expiresAtUtc: number | null;
}

export type CursorCliCredentialRead =
  | { readonly kind: 'found'; readonly credentials: CursorCliCredentials }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly message: string };

export interface CursorCliVaultDocument {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly apiKey: string | null;
  readonly authId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly userId: string;
  readonly capturedAtUtc: number;
}

export interface CursorCliCredentialPorts {
  readonly home?: string;
  readonly keychain?: KeychainPort;
  /** Test seam; production follows AGENT_CLI_CREDENTIAL_STORE. */
  readonly fileStore?: boolean;
}

function readText(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) {
    return null;
  }
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Payload `exp` only — no verification. Missing/unreadable → null. */
function jwtExpiryUtc(token: string): number | null {
  const payload = token.split('.')[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const parsed = asObject(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    const exp = parsed?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? Math.floor(exp) : null;
  } catch {
    return null;
  }
}

function accountIdFromUserId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

/** `authInfo` only — never tokens. Missing or unreadable config is null. */
export function readCursorCliIdentity(home: string = homedir()): CursorCliIdentity | null {
  const document = readJsonObject(defaultCursorCliConfigPath(home));
  const authInfo = document === null ? null : asObject(document.authInfo);
  if (authInfo === null) {
    return null;
  }
  const accountId = accountIdFromUserId(authInfo.userId);
  if (accountId === null) {
    return null;
  }
  return {
    accountId,
    email: asString(authInfo.email),
    displayName: asString(authInfo.displayName),
    authId: asString(authInfo.authId),
  };
}

/**
 * Dashboard host from `serverConfigCache.backendUrl` when it is a
 * bare https origin; anything else falls back to the documented default
 * rather than following an untrusted URL.
 */
export function cursorCliBackendOrigin(home: string = homedir()): string {
  const document = readJsonObject(defaultCursorCliConfigPath(home));
  const cache = document === null ? null : asObject(document.serverConfigCache);
  const raw = cache === null ? null : asString(cache.backendUrl);
  if (raw === null) {
    return 'https://api2.cursor.sh';
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      return 'https://api2.cursor.sh';
    }
    return url.origin;
  } catch {
    return 'https://api2.cursor.sh';
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== null && value.length > 0) {
      return value;
    }
  }
  return null;
}

function credentialsFromRecord(record: Record<string, unknown>): CursorCliCredentials | null {
  const accessToken = firstString(record, ['accessToken', 'access_token', 'token', 'cursorAccessToken']);
  if (accessToken === null) {
    return null;
  }
  return {
    accessToken,
    refreshToken: firstString(record, ['refreshToken', 'refresh_token']),
    apiKey: firstString(record, ['apiKey', 'api_key']),
    expiresAtUtc: jwtExpiryUtc(accessToken),
  };
}

function readFileCredentials(home: string): CursorCliCredentialRead {
  const text = readText(defaultCursorCliAuthPath(home));
  if (text === null) {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'error', message: 'cursor-cli credential file is not valid JSON' };
  }
  const record = asObject(parsed);
  if (record === null) {
    return { kind: 'absent' };
  }
  const nested = asObject(record.auth) ?? asObject(record.credentials) ?? record;
  const credentials = credentialsFromRecord(nested);
  return credentials === null ? { kind: 'absent' } : { kind: 'found', credentials };
}

function collapseRead(
  access: KeychainReadResult,
  refresh: KeychainReadResult,
  apiKey: KeychainReadResult,
): CursorCliCredentialRead {
  if (access.kind === 'error') {
    return { kind: 'error', message: access.message };
  }
  if (refresh.kind === 'error') {
    return { kind: 'error', message: refresh.message };
  }
  if (apiKey.kind === 'error') {
    return { kind: 'error', message: apiKey.message };
  }
  if (access.kind === 'absent') {
    return { kind: 'absent' };
  }
  return {
    kind: 'found',
    credentials: {
      accessToken: access.value,
      refreshToken: refresh.kind === 'found' ? refresh.value : null,
      apiKey: apiKey.kind === 'found' ? apiKey.value : null,
      expiresAtUtc: jwtExpiryUtc(access.value),
    },
  };
}

/**
 * Three-state credential read. A locked or timed-out keychain is
 * `error`, never `absent` — collapsing those is how a switch overwrites
 * a secret it merely could not see.
 */
export function readCursorCliCredentials(
  ports: CursorCliCredentialPorts = {},
): CursorCliCredentialRead {
  const home = ports.home ?? homedir();
  const fileStore =
    ports.fileStore === true || process.env.AGENT_CLI_CREDENTIAL_STORE === 'file';
  if (fileStore) {
    return readFileCredentials(home);
  }
  const keychain = ports.keychain ?? macosKeychain;
  if (!keychain.available) {
    return readFileCredentials(home);
  }
  const combined = collapseRead(
    keychain.read(ACCESS_SERVICE, KEYCHAIN_ACCOUNT),
    keychain.read(REFRESH_SERVICE, KEYCHAIN_ACCOUNT),
    keychain.read(API_KEY_SERVICE, KEYCHAIN_ACCOUNT),
  );
  if (combined.kind === 'error') {
    return combined;
  }
  if (combined.kind === 'found') {
    return combined;
  }
  return readFileCredentials(home);
}

/** Lineage id: refresh token when present, otherwise the access token. */
export function cursorCliCredentialFingerprint(credentials: CursorCliCredentials): string {
  const basis = credentials.refreshToken ?? credentials.accessToken;
  const hash = new Bun.CryptoHasher('sha256').update(basis).digest('hex');
  return credentials.refreshToken !== null ? `sha256:${hash}` : `sha256-access:${hash}`;
}

export function serializeCursorCliVaultDocument(document: CursorCliVaultDocument): string {
  return JSON.stringify(document);
}

export function readStoredCursorCliDocument(text: string): CursorCliVaultDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asObject(parsed);
  if (record === null) {
    return null;
  }
  const accessToken = asString(record.accessToken);
  const userId = asString(record.userId);
  if (accessToken === null || userId === null || accessToken.length === 0 || userId.length === 0) {
    return null;
  }
  const capturedAtUtc = record.capturedAtUtc;
  return {
    accessToken,
    refreshToken: asString(record.refreshToken),
    apiKey: asString(record.apiKey),
    authId: asString(record.authId),
    email: asString(record.email),
    displayName: asString(record.displayName),
    userId,
    capturedAtUtc:
      typeof capturedAtUtc === 'number' && Number.isFinite(capturedAtUtc)
        ? capturedAtUtc
        : 0,
  };
}

export function credentialsFromVaultDocument(document: CursorCliVaultDocument): CursorCliCredentials {
  return {
    accessToken: document.accessToken,
    refreshToken: document.refreshToken,
    apiKey: document.apiKey,
    expiresAtUtc: jwtExpiryUtc(document.accessToken),
  };
}

const LOGIN_HINT =
  'run "cursor agent login" (or "cursor-agent login") as this account once (llmtally auto-heals)';

export function captureCursorCliAccount(ports: {
  readonly vault: AccountVault;
  readonly home?: string;
  readonly nowUtc?: number;
  readonly keychain?: KeychainPort;
  readonly fileStore?: boolean;
}): VaultEntry {
  const home = ports.home ?? homedir();
  const identity = readCursorCliIdentity(home);
  if (identity === null) {
    throw new CursorCliAccountError(`no Cursor CLI login in cli-config.json — ${LOGIN_HINT}`);
  }
  const read = readCursorCliCredentials({
    home,
    ...(ports.keychain === undefined ? {} : { keychain: ports.keychain }),
    ...(ports.fileStore === undefined ? {} : { fileStore: ports.fileStore }),
  });
  if (read.kind === 'error') {
    throw new CursorCliAccountError(read.message);
  }
  if (read.kind === 'absent') {
    throw new CursorCliAccountError(`no Cursor CLI credentials found — ${LOGIN_HINT}`);
  }
  const nowUtc = ports.nowUtc ?? Math.floor(Date.now() / 1000);
  const existing = ports.vault.get(CURSOR_CLI_AGENT, identity.accountId);
  const document: CursorCliVaultDocument = {
    accessToken: read.credentials.accessToken,
    refreshToken: read.credentials.refreshToken,
    apiKey: read.credentials.apiKey,
    authId: identity.authId,
    email: identity.email,
    displayName: identity.displayName,
    userId: identity.accountId,
    capturedAtUtc: nowUtc,
  };
  return ports.vault.put(
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
    serializeCursorCliVaultDocument(document),
  );
}

export const CURSOR_CLI_KEYCHAIN = {
  account: KEYCHAIN_ACCOUNT,
  accessService: ACCESS_SERVICE,
  refreshService: REFRESH_SERVICE,
  apiKeyService: API_KEY_SERVICE,
} as const;
