import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import {
  captureCursorCliAccount,
  cursorCliCredentialFingerprint,
  readCursorCliCredentials,
  readCursorCliIdentity,
} from '@llmtally/core/accounts/cursor-cli.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import type { KeychainPort } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const USER_ID = '405';
const ACCESS = 'cursor-access-token-fixture';
const REFRESH = 'cursor-refresh-token-fixture';

function writeConfig(home: string, authInfo: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(
    join(home, '.cursor', 'cli-config.json'),
    JSON.stringify({
      authInfo,
      model: { modelId: 'keep-me' },
      ...extra,
    }),
  );
}

describe('readCursorCliIdentity', () => {
  test('reads userId as a decimal string and ignores authId', () => {
    const home = makeTempDir();
    writeConfig(home, {
      userId: 405,
      authId: 'auth|pipe:colon',
      email: 'dev@example.com',
      displayName: 'Dev',
    });

    expect(readCursorCliIdentity(home)).toEqual({
      accountId: USER_ID,
      email: 'dev@example.com',
      displayName: 'Dev',
      authId: 'auth|pipe:colon',
    });
  });

  test('returns null when authInfo is missing', () => {
    const home = makeTempDir();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'cli-config.json'), JSON.stringify({ model: {} }));
    expect(readCursorCliIdentity(home)).toBeNull();
  });
});

describe('readCursorCliCredentials', () => {
  test('reads the file backend with tolerant key names', () => {
    const home = makeTempDir();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.cursor', 'auth.json'),
      JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH }),
    );

    const read = readCursorCliCredentials({ home, fileStore: true });
    expect(read).toEqual({
      kind: 'found',
      credentials: {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        apiKey: null,
        expiresAtUtc: null,
      },
    });
  });

  test('a keychain error is not collapsed into absent', () => {
    const keychain: KeychainPort = {
      available: true,
      read: () => ({ kind: 'error', message: 'keychain locked' }),
      write: () => {
        throw new Error('no');
      },
      remove: () => undefined,
      findAccount: () => null,
    };
    const read = readCursorCliCredentials({ home: makeTempDir(), keychain });
    expect(read.kind).toBe('error');
  });

  test('reads from a memory keychain when present', () => {
    const keychain = createMemoryKeychain();
    keychain.write('cursor-access-token', 'cursor-user', ACCESS);
    keychain.write('cursor-refresh-token', 'cursor-user', REFRESH);
    const read = readCursorCliCredentials({ home: makeTempDir(), keychain });
    expect(read.kind).toBe('found');
    if (read.kind === 'found') {
      expect(read.credentials.accessToken).toBe(ACCESS);
      expect(read.credentials.refreshToken).toBe(REFRESH);
    }
  });
});

describe('captureCursorCliAccount', () => {
  test('stores a vault entry keyed on userId', () => {
    const home = makeTempDir();
    writeConfig(home, { userId: USER_ID, email: 'dev@example.com', authId: 'auth-1' });
    writeFileSync(
      join(home, '.cursor', 'auth.json'),
      JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH }),
    );
    const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain(false) });

    const entry = captureCursorCliAccount({ vault, home, fileStore: true, nowUtc: 1_800_000_000 });

    expect(entry.agent).toBe('cursor-cli');
    expect(entry.accountId).toBe(USER_ID);
    expect(entry.email).toBe('dev@example.com');
    const stored = vault.loadCredentials('cursor-cli', USER_ID);
    expect(JSON.parse(stored ?? '{}').userId).toBe(USER_ID);
  });

  test('throws a cursor-prefixed login hint when identity is missing', () => {
    const home = makeTempDir();
    const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain(false) });
    try {
      captureCursorCliAccount({ vault, home, fileStore: true });
      throw new Error('expected capture to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('cursor agent login');
      expect(message).toContain('cursor-agent login');
    }
  });
});

describe('discoverAccounts cursor-cli-config', () => {
  test('emits a profile from cli-config authInfo', () => {
    const home = makeTempDir();
    writeConfig(home, { userId: USER_ID, email: 'dev@example.com' });
    const profiles = discoverAccounts({ cursorCliHome: home });
    expect(profiles.some((profile) => profile.agent === 'cursor-cli' && profile.accountId === USER_ID)).toBe(
      true,
    );
  });
});

describe('cursorCliCredentialFingerprint', () => {
  test('prefers the refresh token', () => {
    const withRefresh = cursorCliCredentialFingerprint({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      apiKey: null,
      expiresAtUtc: null,
    });
    const accessOnly = cursorCliCredentialFingerprint({
      accessToken: ACCESS,
      refreshToken: null,
      apiKey: null,
      expiresAtUtc: null,
    });
    expect(withRefresh).not.toBe(accessOnly);
    expect(withRefresh.startsWith('sha256:')).toBe(true);
  });
});
