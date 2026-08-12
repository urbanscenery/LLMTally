import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  captureCodexAccount,
  codexCredentialFingerprint,
  detachCodexLogin,
  switchCodexAccount,
} from '@llmtally/core/accounts/codex.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault, VAULT_KEYCHAIN_SERVICE } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function jwtWithEmail(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
  return `x.${payload}.y`;
}

function authJson(accountId: string, refresh: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwtWithEmail(`${accountId}@test.dev`),
      access_token: `access-${refresh}`,
      refresh_token: refresh,
      account_id: accountId,
    },
    last_refresh: '2026-08-12T07:00:00.000Z',
  });
}

function harness() {
  const home = makeTempDir();
  const authPath = join(home, 'auth.json');
  const keychain = createMemoryKeychain();
  const vault = new AccountVault({ dir: join(home, 'vault'), keychain });
  return { authPath, vault, keychain };
}

describe('codexCredentialFingerprint', () => {
  test('follows the refresh token through access-token rotation', () => {
    // Arrange — codex rotates access_token often, refresh_token rarely
    const first = authJson('acc-1', 'rt-1');
    const rotated = JSON.stringify({
      ...JSON.parse(first),
      tokens: { ...JSON.parse(first).tokens, access_token: 'access-new' },
    });

    // Act & Assert
    expect(codexCredentialFingerprint(first)).toBe(codexCredentialFingerprint(rotated));
    expect(codexCredentialFingerprint(first)).not.toBe(
      codexCredentialFingerprint(authJson('acc-1', 'rt-2')),
    );
  });
});

describe('captureCodexAccount', () => {
  test('stores the current codex login under agent codex', () => {
    // Arrange
    const { authPath, vault, keychain } = harness();
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));

    // Act
    const entry = captureCodexAccount({ vault, authPath, nowUtc: NOW });

    // Assert — vault entry + keychain item under the codex prefix
    expect(entry.agent).toBe('codex');
    expect(entry.accountId).toBe('acc-1');
    expect(entry.email).toBe('acc-1@test.dev');
    expect(vault.loadCredentials('codex', 'acc-1')).toBe(authJson('acc-1', 'rt-1'));
    expect(keychain.read(VAULT_KEYCHAIN_SERVICE, 'codex:acc-1')).not.toBeNull();
  });

  test('re-capturing the same account updates without duplicating', () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson('acc-1', 'rt-2'));

    // Act
    captureCodexAccount({ vault, authPath, nowUtc: NOW + 60 });

    // Assert
    expect(vault.list().filter((entry) => entry.agent === 'codex')).toHaveLength(1);
    expect(JSON.parse(vault.loadCredentials('codex', 'acc-1') ?? '{}').tokens.refresh_token).toBe('rt-2');
  });

  test('a missing or token-less auth.json refuses loudly', () => {
    // Arrange
    const { authPath, vault } = harness();

    // Act & Assert — nothing on disk
    expect(() => captureCodexAccount({ vault, authPath, nowUtc: NOW })).toThrow(/codex login/);
    // ...and a file without usable tokens
    writeFileSync(authPath, JSON.stringify({ tokens: {} }));
    expect(() => captureCodexAccount({ vault, authPath, nowUtc: NOW })).toThrow(/codex login/);
  });
});

describe('detachCodexLogin', () => {
  test('stores the live login and removes auth.json', () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));

    // Act
    const result = detachCodexLogin({ vault, authPath, nowUtc: NOW });

    // Assert — preserved in the vault, gone from the file
    expect(result.entry.accountId).toBe('acc-1');
    expect(vault.loadCredentials('codex', 'acc-1')).toBe(authJson('acc-1', 'rt-1'));
    expect(existsSync(authPath)).toBe(false);
  });

  test('refuses when there is no usable login to preserve', () => {
    // Arrange — an API-key auth.json carries no oauth login
    const { authPath, vault } = harness();
    writeFileSync(authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }));

    // Act & Assert — the file must survive a refusal
    expect(() => detachCodexLogin({ vault, authPath, nowUtc: NOW })).toThrow(/codex login/);
    expect(existsSync(authPath)).toBe(true);
  });

  test('a detached login can still be switched back in', async () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));
    detachCodexLogin({ vault, authPath, nowUtc: NOW });

    // Act
    const result = await switchCodexAccount('acc-1', { vault, authPath, nowUtc: NOW });

    // Assert
    expect(result.target.accountId).toBe('acc-1');
    expect(readFileSync(authPath, 'utf8')).toBe(authJson('acc-1', 'rt-1'));
  });
});

describe('switchCodexAccount', () => {
  test('swaps auth.json atomically and backs up the outgoing login', async () => {
    // Arrange — acc-1 live (rotated since captured), acc-2 stored
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson('acc-2', 'rt-2'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });
    // live rotates back to acc-1 with a fresher access token
    const liveRotated = JSON.stringify({
      ...JSON.parse(authJson('acc-1', 'rt-1')),
      tokens: { ...JSON.parse(authJson('acc-1', 'rt-1')).tokens, access_token: 'access-fresher' },
    });
    writeFileSync(authPath, liveRotated);

    // Act
    const result = await switchCodexAccount('acc-2', { vault, authPath, nowUtc: NOW });

    // Assert — the file now holds acc-2, the fresher acc-1 bytes were backed up
    expect(result.target.accountId).toBe('acc-2');
    expect(result.outgoing).toBe('own');
    expect(JSON.parse(readFileSync(authPath, 'utf8')).tokens.account_id).toBe('acc-2');
    expect(JSON.parse(vault.loadCredentials('codex', 'acc-1') ?? '{}').tokens.access_token).toBe(
      'access-fresher',
    );
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  test('resolves by email and alias among codex entries only', async () => {
    // Arrange — a claude entry shares the email
    const { authPath, vault } = harness();
    vault.put(
      {
        agent: 'claude-code',
        accountId: 'claude-uuid',
        email: 'acc-2@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
    );
    writeFileSync(authPath, authJson('acc-2', 'rt-2'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));

    // Act — email resolves to the CODEX account, never the claude one
    const result = await switchCodexAccount('acc-2@test.dev', { vault, authPath, nowUtc: NOW });

    // Assert
    expect(result.target.accountId).toBe('acc-2');
    expect(JSON.parse(readFileSync(authPath, 'utf8')).tokens.account_id).toBe('acc-2');
  });

  test('unknown live credentials are stashed, never overwritten silently', async () => {
    // Arrange — the live login was never captured
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-2', 'rt-2'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson('acc-stranger', 'rt-stranger'));

    // Act
    const result = await switchCodexAccount('acc-2', { vault, authPath, nowUtc: NOW });

    // Assert
    expect(result.outgoing).toBe('unclaimed');
    expect(result.stashId).not.toBeNull();
    const stashed = readFileSync(
      join(vault.directory, 'unclaimed', `${result.stashId}.cred`),
      'utf8',
    );
    expect(Buffer.from(stashed, 'base64').toString('utf8')).toBe(
      authJson('acc-stranger', 'rt-stranger'),
    );
  });

  test('aborts when auth.json changes between read and write (rotation race)', async () => {
    // Arrange — codex CLI rewrites the file mid-switch
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-2', 'rt-2'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));

    // Act — simulate the interleaving write via the pre-write hook
    await expect(
      switchCodexAccount('acc-2', {
        vault,
        authPath,
        nowUtc: NOW,
        beforeWrite: () => {
          writeFileSync(authPath, authJson('acc-1', 'rt-1-rotated'));
        },
      }),
    ).rejects.toThrow(/changed while switching/);

    // Assert — the concurrent rotation survived untouched
    expect(JSON.parse(readFileSync(authPath, 'utf8')).tokens.refresh_token).toBe('rt-1-rotated');
  });

  test('refuses a refresh-dead codex entry with recovery guidance', async () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-2', 'rt-2'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });
    vault.markRefreshDeadIfFingerprint(
      'codex',
      'acc-2',
      (await import('@llmtally/core/accounts/credentials.ts')).credentialFingerprint(
        vault.loadCredentials('codex', 'acc-2') ?? '',
      ),
      NOW,
    );
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));

    // Act & Assert
    await expect(switchCodexAccount('acc-2', { vault, authPath, nowUtc: NOW })).rejects.toThrow(
      /codex login/,
    );
  });

  test('a switch to the already-active account is a safe no-op warning', async () => {
    // Arrange
    const { authPath, vault } = harness();
    writeFileSync(authPath, authJson('acc-1', 'rt-1'));
    captureCodexAccount({ vault, authPath, nowUtc: NOW });

    // Act
    const result = await switchCodexAccount('acc-1', { vault, authPath, nowUtc: NOW });

    // Assert
    expect(result.warnings.join(' ')).toContain('already');
    expect(JSON.parse(readFileSync(authPath, 'utf8')).tokens.refresh_token).toBe('rt-1');
  });
});
