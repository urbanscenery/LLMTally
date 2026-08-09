import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compactJson,
  credentialFingerprint,
  createActiveCredentialStore,
  isWipedCredential,
  prepareForActivation,
} from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain, parseAccountAttribute } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault, normalizeAlias } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function credentials(refresh: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `access-${refresh}`,
      refreshToken: refresh,
      expiresAt: 1_800_000_000_000,
      subscriptionType: 'max',
    },
    ...extra,
  });
}

function entry(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: 'claude-code',
    accountId,
    email: `${accountId}@test.dev`,
    organizationUuid: 'org-1',
    organizationName: 'Test Org',
    alias: null,
    addedAtUtc: NOW,
    ...overrides,
  };
}

describe('parseAccountAttribute', () => {
  test('extracts the acct blob from a security attribute dump', () => {
    // Arrange
    const dump = [
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="someone"',
      '    "svce"<blob>="Claude Code-credentials"',
    ].join('\n');

    // Act & Assert
    expect(parseAccountAttribute(dump)).toBe('someone');
    expect(parseAccountAttribute('attributes:\n    "svce"<blob>="x"')).toBeNull();
  });
});

describe('credential helpers', () => {
  test('the fingerprint follows the refresh token through access rotation', () => {
    // Arrange — same account, rotated access token
    const first = credentials('refresh-1');
    const rotated = JSON.stringify({
      claudeAiOauth: { accessToken: 'access-new', refreshToken: 'refresh-1' },
    });

    // Act & Assert
    expect(credentialFingerprint(first)).toBe(credentialFingerprint(rotated));
    expect(credentialFingerprint(first)).not.toBe(credentialFingerprint(credentials('refresh-2')));
  });

  test('blank tokens are recognized as a signed-out state', () => {
    // Act & Assert
    expect(
      isWipedCredential(JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } })),
    ).toBe(true);
    expect(isWipedCredential(credentials('refresh-1'))).toBe(false);
  });

  test('machine-scoped keys come from the live copy, absence included', () => {
    // Arrange — the stored snapshot carries a stale MCP grant
    const stored = credentials('refresh-1', {
      mcpOAuth: { server: 'stale' },
      trustedDeviceToken: 'device-1',
    });
    const live = credentials('refresh-2', { mcpOAuth: { server: 'current' } });

    // Act
    const activated = JSON.parse(prepareForActivation(stored, live));
    const withoutLiveMcp = JSON.parse(prepareForActivation(stored, credentials('refresh-2')));

    // Assert — account keys move, machine keys track the live store
    expect(activated.claudeAiOauth.refreshToken).toBe('refresh-1');
    expect(activated.trustedDeviceToken).toBe('device-1');
    expect(activated.mcpOAuth).toEqual({ server: 'current' });
    expect('mcpOAuth' in withoutLiveMcp).toBe(false);
  });

  test('non-JSON credentials are rejected instead of stored', () => {
    // Act & Assert
    expect(() => compactJson('not json')).toThrow('not valid JSON');
    expect(() => compactJson('[1,2]')).toThrow('must be a JSON object');
  });
});

describe('createActiveCredentialStore', () => {
  test('keychain writes compact JSON and bump an existing credentials file', () => {
    // Arrange
    const configHome = makeTempDir();
    const filePath = join(configHome, '.credentials.json');
    writeFileSync(filePath, '{}');
    const before = statSync(filePath).mtimeMs;
    const keychain = createMemoryKeychain();
    const store = createActiveCredentialStore({ configHome, keychain, keychainAccount: 'me' });

    // Act
    store.write(`${credentials('refresh-1')}\n`);

    // Assert — stored on one line, file untouched in content but touched in mtime
    expect(store.backend).toBe('keychain');
    expect(keychain.read('Claude Code-credentials', 'me')).toBe(credentials('refresh-1'));
    expect(readFileSync(filePath, 'utf8')).toBe('{}');
    expect(statSync(filePath).mtimeMs).toBeGreaterThanOrEqual(before);
  });

  test('a keychain-only machine never gains a plaintext credentials file', () => {
    // Arrange — no file exists to begin with
    const configHome = makeTempDir();
    const store = createActiveCredentialStore({
      configHome,
      keychain: createMemoryKeychain(),
      keychainAccount: 'me',
    });

    // Act
    store.write(credentials('refresh-1'));
    store.touch();

    // Assert
    expect(() => readFileSync(join(configHome, '.credentials.json'), 'utf8')).toThrow();
  });

  test('without a keychain the file backend is used at 0600', () => {
    // Arrange
    const configHome = makeTempDir();
    const store = createActiveCredentialStore({
      configHome,
      keychain: createMemoryKeychain(false),
    });

    // Act
    store.write(credentials('refresh-1'));

    // Assert
    const filePath = join(configHome, '.credentials.json');
    expect(store.backend).toBe('file');
    expect(store.read()).toBe(credentials('refresh-1'));
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

describe('AccountVault', () => {
  function makeVault(available = true) {
    return new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain(available) });
  }

  test('stores credentials in the keychain and reads them back', () => {
    // Arrange
    const vault = makeVault();

    // Act
    const stored = vault.put(entry('uuid-1'), credentials('refresh-1'));

    // Assert
    expect(stored.backend).toBe('keychain');
    expect(vault.loadCredentials('uuid-1')).toBe(credentials('refresh-1'));
    expect(vault.list()).toHaveLength(1);
  });

  test('falls back to a 0600 file when no keychain is available', () => {
    // Arrange
    const vault = makeVault(false);

    // Act
    const stored = vault.put(entry('uuid-1'), credentials('refresh-1'));

    // Assert
    expect(stored.backend).toBe('file');
    expect(vault.loadCredentials('uuid-1')).toBe(credentials('refresh-1'));
    expect(statSync(join(vault.directory, 'uuid-1.cred')).mode & 0o777).toBe(0o600);
  });

  test('empty credentials are refused rather than stored', () => {
    // Act & Assert
    expect(() => makeVault().put(entry('uuid-1'), '')).toThrow('refusing to store empty');
  });

  test('resolve accepts id, alias, and email but refuses an ambiguous email', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1', { alias: 'work' }), credentials('refresh-1'));
    vault.put(entry('uuid-2', { email: 'uuid-1@test.dev' }), credentials('refresh-2'));

    // Act & Assert
    expect(vault.resolve('uuid-2').accountId).toBe('uuid-2');
    expect(vault.resolve('work').accountId).toBe('uuid-1');
    expect(() => vault.resolve('uuid-1@test.dev')).toThrow('matches 2 accounts');
    expect(() => vault.resolve('nobody')).toThrow('no stored account');
  });

  test('aliases are normalized and cannot collide', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    vault.put(entry('uuid-2'), credentials('refresh-2'));

    // Act
    vault.setAlias('uuid-1', 'Work');

    // Assert
    expect(vault.get('uuid-1')?.alias).toBe('work');
    expect(() => vault.setAlias('uuid-2', 'work')).toThrow('already used');
    expect(() => normalizeAlias('12')).toThrow('invalid alias');
    expect(() => normalizeAlias('-x')).toThrow('invalid alias');
  });

  test('removing an account clears its credentials and active marker', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    vault.setActive('uuid-1');

    // Act
    vault.remove('uuid-1');

    // Assert
    expect(vault.list()).toHaveLength(0);
    expect(vault.loadCredentials('uuid-1')).toBeNull();
    expect(vault.activeAccountId()).toBeNull();
  });

  test('a crafted account id cannot escape the vault or inject a command', () => {
    // Arrange — both PoCs from the security review, built at runtime
    const vault = makeVault(false);
    const injected = `victim${String.fromCharCode(10)}delete-generic-password -s llmtally`;
    const traversal = '../../../../tmp/escaped';

    // Act & Assert — refused before any file or keychain call
    for (const accountId of [injected, traversal, 'has/slash', '', 'a'.repeat(129)]) {
      expect(() => vault.put(entry(accountId), credentials('refresh-1'))).toThrow(
        'refusing to use account id',
      );
    }
    expect(vault.list()).toHaveLength(0);
  });

  test('a keychain write failure removes the stale row it would otherwise hide behind', () => {
    // Arrange — first store succeeds, then the payload outgrows the CLI
    const vault = new AccountVault({
      dir: makeTempDir(),
      keychain: createMemoryKeychain(true, 4000),
    });
    vault.put(entry('uuid-1'), credentials('refresh-old'));
    const huge = JSON.stringify({
      claudeAiOauth: { accessToken: 'x'.repeat(6000), refreshToken: 'refresh-new' },
    });

    // Act
    const stored = vault.put(entry('uuid-1'), huge);

    // Assert — the newer credentials are what comes back, not the old row
    expect(stored.backend).toBe('file');
    expect(vault.loadCredentials('uuid-1')).toBe(huge);
  });

  test('unclaimed credentials are preserved with a manifest', () => {
    // Arrange
    const vault = makeVault();

    // Act
    const id = vault.stashUnclaimed(credentials('refresh-x'), 'no match', NOW);

    // Assert
    const stashed = readFileSync(join(vault.directory, 'unclaimed', `${id}.cred`), 'utf8');
    expect(Buffer.from(stashed, 'base64').toString('utf8')).toBe(credentials('refresh-x'));
    expect(readFileSync(join(vault.directory, 'unclaimed', `${id}.json`), 'utf8')).toContain(
      'no match',
    );
  });
});
