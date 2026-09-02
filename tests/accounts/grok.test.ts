import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import {
  captureGrokAccounts,
  grokEntryFingerprint,
  readGrokAuthEntries,
  readGrokIdentities,
  readStoredGrokEntry,
} from '@llmtally/core/accounts/grok.ts';
import { credentialFingerprint } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

function writeAuth(document: unknown): string {
  const path = join(makeTempDir(), 'auth.json');
  writeFileSync(path, JSON.stringify(document));
  return path;
}

const ACCOUNT = {
  key: 'eyJ0eXAiOiJhpretend.access.token',
  auth_mode: 'oidc',
  user_id: 'abc3a509-e881-4d18-9f1e-6a3f0b2c4d5e',
  email: 'dev@example.com',
  team_id: 'aa5ce99c-fd51-4a2b-9c8d-1e2f3a4b5c6d',
  refresh_token: 'pretend-refresh-token',
  oidc_issuer: 'https://auth.x.ai',
};

describe('readGrokIdentities', () => {
  test('reads the identity of every issuer entry, ignoring the secrets beside it', () => {
    // Arrange
    const path = writeAuth({
      'https://auth.x.ai::client-1': ACCOUNT,
      'https://auth.x.ai::client-2': { ...ACCOUNT, user_id: 'second-uuid', email: 'two@example.com' },
    });

    // Act
    const identities = readGrokIdentities(path);

    // Assert
    expect(identities).toEqual([
      {
        accountId: 'abc3a509-e881-4d18-9f1e-6a3f0b2c4d5e',
        email: 'dev@example.com',
        teamId: 'aa5ce99c-fd51-4a2b-9c8d-1e2f3a4b5c6d',
      },
      { accountId: 'second-uuid', email: 'two@example.com', teamId: ACCOUNT.team_id },
    ]);
    expect(JSON.stringify(identities)).not.toContain('pretend');
  });

  test('skips records with no user id rather than keying on the email', () => {
    // Arrange
    const path = writeAuth({ 'https://auth.x.ai::client-1': { email: 'dev@example.com' } });

    // Act & Assert
    expect(readGrokIdentities(path)).toEqual([]);
  });

  test('treats a missing or unreadable store as no accounts', () => {
    // Act & Assert
    expect(readGrokIdentities(join(makeTempDir(), 'absent.json'))).toEqual([]);
    expect(readGrokIdentities(writeAuth('not an object'))).toEqual([]);
  });
});

describe('readGrokAuthEntries', () => {
  test('carries the tokens, identity, and expiry of every slot', () => {
    // Arrange
    const text = JSON.stringify({
      'https://auth.x.ai::client-1': { ...ACCOUNT, expires_at: '2026-08-16T20:46:50.017022Z' },
    });

    // Act
    const [entry] = readGrokAuthEntries(text);

    // Assert
    expect(entry?.entryKey).toBe('https://auth.x.ai::client-1');
    expect(entry?.accountId).toBe(ACCOUNT.user_id);
    expect(entry?.accessToken).toBe(ACCOUNT.key);
    expect(entry?.refreshToken).toBe(ACCOUNT.refresh_token);
    expect(entry?.expiresAtUtc).toBe(Math.floor(Date.parse('2026-08-16T20:46:50.017022Z') / 1000));
  });

  test('readStoredGrokEntry demands an id and a token, not just an entry', () => {
    // Act & Assert
    expect(readStoredGrokEntry(JSON.stringify({ 'i::c': { email: 'x@y.z' } }))).toBeNull();
    expect(readStoredGrokEntry('torn {')).toBeNull();
    expect(readStoredGrokEntry(JSON.stringify({ 'i::c': ACCOUNT }))?.accountId).toBe(
      ACCOUNT.user_id,
    );
  });
});

describe('grokEntryFingerprint', () => {
  test('follows the refresh token, not the JSON formatting', () => {
    // Arrange — same generation, different serializations
    const [compact] = readGrokAuthEntries(JSON.stringify({ 'i::c': ACCOUNT }));
    const [pretty] = readGrokAuthEntries(JSON.stringify({ 'i::c': ACCOUNT }, null, 2));
    const [rotated] = readGrokAuthEntries(
      JSON.stringify({ 'i::c': { ...ACCOUNT, refresh_token: 'rotated' } }),
    );

    // Act & Assert
    expect(grokEntryFingerprint(compact!)).toBe(grokEntryFingerprint(pretty!));
    expect(grokEntryFingerprint(compact!)).not.toBe(grokEntryFingerprint(rotated!));
  });
});

describe('captureGrokAccounts', () => {
  function makeVault(): AccountVault {
    return new AccountVault({ dir: join(makeTempDir(), 'vault'), keychain: createMemoryKeychain() });
  }

  test('stores every live login as its own single-entry document', () => {
    // Arrange
    const vault = makeVault();
    const authPath = writeAuth({
      'https://auth.x.ai::client-1': ACCOUNT,
      'https://auth.x.ai::client-2': { ...ACCOUNT, user_id: 'second-uuid', email: 'two@example.com' },
    });

    // Act
    const { entries, failures } = captureGrokAccounts({ vault, authPath, nowUtc: 1_786_400_000 });

    // Assert — each account is retrievable and its stored bytes carry
    // only its own issuer::client slot
    expect(failures).toEqual([]);
    expect(entries.map((entry) => entry.accountId)).toEqual([ACCOUNT.user_id, 'second-uuid']);
    const stored = vault.loadCredentials('grok', 'second-uuid') ?? '';
    expect(Object.keys(JSON.parse(stored))).toEqual(['https://auth.x.ai::client-2']);
    expect(readStoredGrokEntry(stored)?.email).toBe('two@example.com');
  });

  test('a re-capture preserves the alias and lifts a quarantine', () => {
    // Arrange
    const vault = makeVault();
    const authPath = writeAuth({ 'https://auth.x.ai::client-1': ACCOUNT });
    captureGrokAccounts({ vault, authPath, nowUtc: 1_786_400_000 });
    vault.setAlias('grok', ACCOUNT.user_id, 'work');
    vault.markRefreshDeadIfFingerprint(
      'grok',
      ACCOUNT.user_id,
      credentialFingerprint(vault.loadCredentials('grok', ACCOUNT.user_id) ?? ''),
      1_786_400_100,
    );

    // Act
    const [entry] = captureGrokAccounts({ vault, authPath, nowUtc: 1_786_400_200 }).entries;

    // Assert
    expect(entry?.alias).toBe('work');
    expect(entry?.refreshDeadAtUtc).toBeNull();
  });

  test('refuses when no usable login exists', () => {
    // Arrange
    const vault = makeVault();
    const authPath = writeAuth({ 'https://auth.x.ai::client-1': { email: 'only@identity.dev' } });

    // Act & Assert
    expect(() => captureGrokAccounts({ vault, authPath })).toThrow(/no usable Grok login/);
  });
});

describe('discoverAccounts', () => {
  test('surfaces the Grok login as a read-only profile', () => {
    // Arrange — every other source points at an empty directory
    const empty = makeTempDir();
    const grokAuthPath = writeAuth({ 'https://auth.x.ai::client-1': ACCOUNT });

    // Act
    const profiles = discoverAccounts({
      claudeConfigPath: join(empty, 'claude.json'),
      codexAuthPath: join(empty, 'codex.json'),
      antigravityStoreDir: join(empty, 'antigravity'),
      opencodeAuthPath: join(empty, 'opencode.json'),
      grokAuthPath,
      cursorCliHome: empty,
    });

    // Assert
    expect(profiles).toEqual([
      {
        agent: 'grok',
        accountId: ACCOUNT.user_id,
        displayLabel: 'dev@example.com',
        email: 'dev@example.com',
        organizationId: ACCOUNT.team_id,
        discoveredVia: 'grok-auth',
      },
    ]);
  });
});
