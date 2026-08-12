import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  captureOpencodeAccount,
  opencodeAccountId,
  opencodeCredentialFingerprint,
  readOpencodeApiKey,
  readOpencodeProviders,
  switchOpencodeAccount,
} from '@llmtally/core/accounts/opencode.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault, VAULT_KEYCHAIN_SERVICE } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function authJson(keys: Record<string, string>): string {
  const providers: Record<string, unknown> = {};
  for (const [provider, key] of Object.entries(keys)) {
    providers[provider] = { type: 'api', key };
  }
  return JSON.stringify(providers);
}

function harness() {
  const home = makeTempDir();
  const authPath = join(home, 'auth.json');
  const keychain = createMemoryKeychain();
  const vault = new AccountVault({ dir: join(home, 'vault'), keychain });
  return { authPath, vault, keychain };
}

describe('opencode auth parsing', () => {
  test('lists the providers a credential file carries', () => {
    // Act
    const providers = readOpencodeProviders(
      authJson({ 'opencode-go': 'sk-a', 'cline-pass': 'sk_b' }),
    );

    // Assert — sorted, so the identity is order-independent
    expect(providers).toEqual(['cline-pass', 'opencode-go']);
  });

  test('the account id is stable across reordering but not across key changes', () => {
    // Arrange — same keys, different JSON order
    const a = authJson({ 'opencode-go': 'sk-a', 'cline-pass': 'sk_b' });
    const b = authJson({ 'cline-pass': 'sk_b', 'opencode-go': 'sk-a' });
    const rotated = authJson({ 'opencode-go': 'sk-DIFFERENT', 'cline-pass': 'sk_b' });

    // Act & Assert
    expect(opencodeAccountId(a)).toBe(opencodeAccountId(b));
    expect(opencodeAccountId(a)).not.toBe(opencodeAccountId(rotated));
    // readable: provider names + a short fingerprint, vault-safe charset
    expect(opencodeAccountId(a)).toMatch(/^cline-pass\.opencode-go\.[0-9a-f]{6}$/);
  });

  test('a provider carrying no credential material is not a usable login', () => {
    // Arrange — a shape discriminator without a secret authenticates
    // nothing, so it must not derive an identity or count as a provider
    const empty = JSON.stringify({ anthropic: {} });
    const typeOnly = JSON.stringify({ anthropic: { type: 'api' } });
    const emptyKey = JSON.stringify({ anthropic: { type: 'api', key: '' } });
    const whitespaceKey = JSON.stringify({ anthropic: { type: 'api', key: '   ' } });
    const oauthTypeOnly = JSON.stringify({ anthropic: { type: 'oauth' } });
    const metadataOnly = JSON.stringify({
      anthropic: { type: 'oauth', accountId: 'acct', enterpriseUrl: 'https://x' },
    });
    const mixed = JSON.stringify({ anthropic: {}, 'opencode-go': { type: 'api', key: 'sk-x' } });

    // Act & Assert
    expect(readOpencodeProviders(empty)).toEqual([]);
    expect(readOpencodeProviders(typeOnly)).toEqual([]);
    expect(readOpencodeProviders(emptyKey)).toEqual([]);
    expect(readOpencodeProviders(whitespaceKey)).toEqual([]);
    expect(readOpencodeProviders(oauthTypeOnly)).toEqual([]);
    expect(readOpencodeProviders(metadataOnly)).toEqual([]);
    // a real oauth secret still qualifies
    expect(
      readOpencodeProviders(JSON.stringify({ anthropic: { type: 'oauth', refresh: 'rt' } })),
    ).toEqual(['anthropic']);
    expect(readOpencodeProviders(mixed)).toEqual(['opencode-go']);
  });

  test('an oauth entry fingerprints by refresh token, surviving access rotation', () => {
    // Arrange
    const before = JSON.stringify({
      anthropic: { type: 'oauth', access: 'at-1', refresh: 'rt-1', expires: 1 },
    });
    const rotatedAccess = JSON.stringify({
      anthropic: { type: 'oauth', access: 'at-2', refresh: 'rt-1', expires: 2 },
    });
    const rotatedRefresh = JSON.stringify({
      anthropic: { type: 'oauth', access: 'at-2', refresh: 'rt-2', expires: 2 },
    });

    // Act & Assert
    expect(opencodeCredentialFingerprint(before)).toBe(
      opencodeCredentialFingerprint(rotatedAccess),
    );
    expect(opencodeCredentialFingerprint(before)).not.toBe(
      opencodeCredentialFingerprint(rotatedRefresh),
    );
  });
});

describe('readOpencodeApiKey', () => {
  test('returns the key of exactly the provider asked for', () => {
    // Arrange
    const text = authJson({ 'opencode-go': 'sk-go', 'cline-pass': 'sk-pass' });

    // Act & Assert — a look-alike provider must never be spent as another
    expect(readOpencodeApiKey(text, 'opencode-go')).toBe('sk-go');
    expect(readOpencodeApiKey(text, 'cline-pass')).toBe('sk-pass');
    expect(readOpencodeApiKey(text, 'opencode')).toBeNull();
    expect(readOpencodeApiKey(text, 'cline')).toBeNull();
  });

  test('has nothing to offer for an absent provider or an unusable file', () => {
    // Act & Assert
    expect(readOpencodeApiKey(authJson({ 'cline-pass': 'sk-pass' }), 'opencode-go')).toBeNull();
    expect(readOpencodeApiKey('{not json', 'opencode-go')).toBeNull();
    expect(readOpencodeApiKey('{}', 'opencode-go')).toBeNull();
  });

  test('ignores a provider that authenticates some other way', () => {
    // Arrange
    const oauth = JSON.stringify({
      'opencode-go': { type: 'oauth', access: 'at-1', refresh: 'rt-1' },
    });

    // Act & Assert — an oauth entry has no key to send as a bearer token
    expect(readOpencodeApiKey(oauth, 'opencode-go')).toBeNull();
  });

  test.each([
    ['empty', ''],
    ['newline', 'sk-a\nX-Injected: 1'],
    ['carriage return', 'sk-a\r\nX-Injected: 1'],
    ['null byte', 'sk-a\u0000'],
  ])('refuses a %s key rather than sending it as a header', (_label, key) => {
    // Act & Assert
    expect(readOpencodeApiKey(authJson({ 'opencode-go': key }), 'opencode-go')).toBeNull();
  });

  test('accepts the punctuation real keys actually contain', () => {
    // Arrange
    const key = 'sk-go_live.AbC-123456789';

    // Act & Assert
    expect(readOpencodeApiKey(authJson({ 'opencode-go': key }), 'opencode-go')).toBe(key);
  });
});

describe('captureOpencodeAccount', () => {
  test('stores the current credential set under agent opencode', () => {
    // Arrange
    const { authPath, vault, keychain } = harness();
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-a' }));

    // Act
    const entry = captureOpencodeAccount({ vault, authPath, nowUtc: NOW });

    // Assert
    expect(entry.agent).toBe('opencode');
    expect(entry.accountId).toMatch(/^opencode-go\.[0-9a-f]{6}$/);
    expect(vault.loadCredentials(entry.accountId)).toBe(authJson({ 'opencode-go': 'sk-a' }));
    expect(keychain.read(VAULT_KEYCHAIN_SERVICE, `opencode:${entry.accountId}`)).not.toBeNull();
  });

  test('re-capturing the same credential set does not duplicate', () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-a' }));
    captureOpencodeAccount({ vault, authPath, nowUtc: NOW });

    // Act
    captureOpencodeAccount({ vault, authPath, nowUtc: NOW + 60 });

    // Assert
    expect(vault.list().filter((entry) => entry.agent === 'opencode')).toHaveLength(1);
  });

  test('a missing or empty auth file refuses with login guidance', () => {
    // Arrange
    const { authPath, vault } = harness();

    // Act & Assert
    expect(() => captureOpencodeAccount({ vault, authPath, nowUtc: NOW })).toThrow(
      /opencode auth login/,
    );
    writeFileSync(authPath, '{}');
    expect(() => captureOpencodeAccount({ vault, authPath, nowUtc: NOW })).toThrow(
      /opencode auth login/,
    );
    // a provider present but empty is still nothing to capture
    writeFileSync(authPath, JSON.stringify({ anthropic: {} }));
    expect(() => captureOpencodeAccount({ vault, authPath, nowUtc: NOW })).toThrow(
      /opencode auth login/,
    );
  });
});

describe('switchOpencodeAccount', () => {
  test('swaps auth.json atomically and backs up the outgoing set', async () => {
    // Arrange — two captured credential sets, set A live
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-a' }));
    const entryA = captureOpencodeAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-b', 'cline-pass': 'sk_c' }));
    const entryB = captureOpencodeAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-a' }));

    // Act
    const result = await switchOpencodeAccount(entryB.accountId, { vault, authPath, nowUtc: NOW });

    // Assert
    expect(result.target.accountId).toBe(entryB.accountId);
    expect(result.outgoing).toBe('own');
    expect(readFileSync(authPath, 'utf8')).toBe(
      authJson({ 'opencode-go': 'sk-b', 'cline-pass': 'sk_c' }),
    );
    expect(vault.loadCredentials(entryA.accountId)).toBe(authJson({ 'opencode-go': 'sk-a' }));
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  test('an unknown live credential set is auto-captured before the swap', async () => {
    // Arrange — the live set was never stored
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-b' }));
    const target = captureOpencodeAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-stranger' }));

    // Act
    const result = await switchOpencodeAccount(target.accountId, { vault, authPath, nowUtc: NOW });

    // Assert — preserved as its own entry, not lost
    expect(result.outgoing).toBe('unclaimed');
    const strangerId = opencodeAccountId(authJson({ 'opencode-go': 'sk-stranger' }));
    expect(vault.loadCredentials(strangerId)).toBe(authJson({ 'opencode-go': 'sk-stranger' }));
  });

  test('aborts when auth.json changes between read and write', async () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-b' }));
    const target = captureOpencodeAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-a' }));

    // Act & Assert
    await expect(
      switchOpencodeAccount(target.accountId, {
        vault,
        authPath,
        nowUtc: NOW,
        beforeWrite: () => {
          writeFileSync(authPath, authJson({ 'opencode-go': 'sk-a', extra: 'sk-new' }));
        },
      }),
    ).rejects.toThrow(/changed while switching/);
    expect(readFileSync(authPath, 'utf8')).toBe(
      authJson({ 'opencode-go': 'sk-a', extra: 'sk-new' }),
    );
  });

  test('a switch to the already-active set is a safe no-op warning', async () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson({ 'opencode-go': 'sk-a' }));
    const entry = captureOpencodeAccount({ vault, authPath, nowUtc: NOW });

    // Act
    const result = await switchOpencodeAccount(entry.accountId, { vault, authPath, nowUtc: NOW });

    // Assert
    expect(result.warnings.join(' ')).toContain('already');
  });
});
