import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readClaudeActiveIdentityState } from '@llmtally/core/accounts/claude.ts';
import {
  recaptureRefreshDeadActiveAccount,
  resolveActiveClaudeContext,
} from '@llmtally/core/accounts/active-claude.ts';
import { credentialFingerprint } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function configWith(oauthAccount: unknown): string {
  const dir = makeTempDir();
  const path = join(dir, '.claude.json');
  writeFileSync(
    path,
    JSON.stringify(oauthAccount === undefined ? { projects: {} } : { projects: {}, oauthAccount }),
  );
  return path;
}

function makeVault(): AccountVault {
  return new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain() });
}

function storedEntry(vault: AccountVault, accountId: string): void {
  vault.put(
    {
      agent: 'claude-code',
      accountId,
      email: `${accountId}@test.dev`,
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
    },
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
  );
}

describe('readClaudeActiveIdentityState', () => {
  test('a config naming an account is identified', () => {
    // Arrange
    const path = configWith({
      accountUuid: 'uuid-1',
      emailAddress: 'me@test.dev',
      organizationUuid: 'org-1',
      organizationName: 'Org',
    });

    // Act
    const state = readClaudeActiveIdentityState(path);

    // Assert
    expect(state.status).toBe('identified');
    if (state.status === 'identified') {
      expect(state.identity.accountUuid).toBe('uuid-1');
      expect(state.identity.email).toBe('me@test.dev');
    }
  });

  test('a readable config without oauthAccount is signed_out, not unreadable', () => {
    // Act
    const state = readClaudeActiveIdentityState(configWith(undefined));

    // Assert — the distinction drives the registry fallback decision
    expect(state.status).toBe('signed_out');
  });

  test('a missing or corrupt config is unreadable', () => {
    // Act
    const missing = readClaudeActiveIdentityState(join(makeTempDir(), 'nope.json'));
    const dir = makeTempDir();
    const corruptPath = join(dir, '.claude.json');
    writeFileSync(corruptPath, '{not json');
    const corrupt = readClaudeActiveIdentityState(corruptPath);

    // Assert
    expect(missing.status).toBe('unreadable');
    expect(corrupt.status).toBe('unreadable');
  });

  test('an oauthAccount without a usable uuid is unreadable, never identified', () => {
    // Act
    const noUuid = readClaudeActiveIdentityState(configWith({ emailAddress: 'me@test.dev' }));
    const emptyUuid = readClaudeActiveIdentityState(configWith({ accountUuid: '  ' }));

    // Assert
    expect(noUuid.status).toBe('unreadable');
    expect(emptyUuid.status).toBe('unreadable');
  });
});

describe('resolveActiveClaudeContext', () => {
  test('a live identity overrides and silently repairs a stale registry marker', () => {
    // Arrange — the registry still points at the previously switched account
    const vault = makeVault();
    storedEntry(vault, 'old-active');
    storedEntry(vault, 'real-active');
    vault.setActive('old-active');
    const configPath = configWith({ accountUuid: 'real-active', emailAddress: 'real@test.dev' });

    // Act
    const context = resolveActiveClaudeContext({ vault, configPath });

    // Assert — context and marker both follow the live login
    expect(context.status).toBe('identified');
    expect(context.activeAccountId).toBe('real-active');
    expect(vault.activeAccountId()).toBe('real-active');
  });

  test('a signed-out config clears a stale marker instead of trusting it', () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'old-active');
    vault.setActive('old-active');

    // Act
    const context = resolveActiveClaudeContext({ vault, configPath: configWith(undefined) });

    // Assert
    expect(context.status).toBe('signed_out');
    expect(context.activeAccountId).toBeNull();
    expect(vault.activeAccountId()).toBeNull();
  });

  test('an unreadable config falls back to the registry marker without writing', () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'marker');
    vault.setActive('marker');

    // Act
    const context = resolveActiveClaudeContext({
      vault,
      configPath: join(makeTempDir(), 'absent.json'),
    });

    // Assert — fallback only here, and the marker survives untouched
    expect(context.status).toBe('unreadable');
    expect(context.activeAccountId).toBe('marker');
    expect(vault.activeAccountId()).toBe('marker');
  });

  test('an identity not yet stored in the vault is still the active account', () => {
    // Arrange — user logged into an account llmtally has never captured
    const vault = makeVault();
    const configPath = configWith({ accountUuid: 'never-stored' });

    // Act
    const context = resolveActiveClaudeContext({ vault, configPath });

    // Assert
    expect(context.activeAccountId).toBe('never-stored');
  });
});

describe('recaptureRefreshDeadActiveAccount', () => {
  const LIVE = JSON.stringify({
    claudeAiOauth: { accessToken: 'live-token', refreshToken: 'live-refresh', expiresAt: 9e12 },
  });

  function storeWith(text: string | null) {
    return {
      backend: 'file' as const,
      read: () => text,
      write: () => undefined,
      clear: () => undefined,
      touch: () => undefined,
    };
  }

  function quarantine(vault: AccountVault, accountId: string): void {
    storedEntry(vault, accountId);
    const stored = vault.loadCredentials(accountId) ?? '';
    vault.markRefreshDeadIfFingerprint(accountId, credentialFingerprint(stored), NOW - 100);
  }

  test('logging back into a quarantined account heals it from the live credentials', () => {
    // Arrange
    const vault = makeVault();
    quarantine(vault, 'acc-dead');
    const configPath = configWith({ accountUuid: 'acc-dead' });
    const context = resolveActiveClaudeContext({ vault, configPath });

    // Act
    const result = recaptureRefreshDeadActiveAccount({
      context,
      vault,
      activeStore: storeWith(LIVE),
      nowUtc: NOW,
    });

    // Assert — credentials replaced, quarantine lifted
    expect(result).toBe('recaptured');
    expect(vault.get('acc-dead')?.refreshDeadAtUtc).toBeNull();
    expect(JSON.parse(vault.loadCredentials('acc-dead') ?? '{}').claudeAiOauth.accessToken).toBe(
      'live-token',
    );
  });

  test('a healthy or unrelated active account changes nothing', () => {
    // Arrange
    const vault = makeVault();
    storedEntry(vault, 'acc-healthy');
    const context = resolveActiveClaudeContext({
      vault,
      configPath: configWith({ accountUuid: 'acc-healthy' }),
    });

    // Act & Assert
    expect(
      recaptureRefreshDeadActiveAccount({
        context,
        vault,
        activeStore: storeWith(LIVE),
        nowUtc: NOW,
      }),
    ).toBe('not_needed');
  });

  test('wiped or unreadable live credentials never overwrite the stored copy', () => {
    // Arrange
    const vault = makeVault();
    quarantine(vault, 'acc-dead');
    const context = resolveActiveClaudeContext({
      vault,
      configPath: configWith({ accountUuid: 'acc-dead' }),
    });
    const wiped = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } });

    // Act & Assert
    expect(
      recaptureRefreshDeadActiveAccount({
        context,
        vault,
        activeStore: storeWith(wiped),
        nowUtc: NOW,
      }),
    ).toBe('unavailable');
    expect(
      recaptureRefreshDeadActiveAccount({
        context,
        vault,
        activeStore: storeWith(null),
        nowUtc: NOW,
      }),
    ).toBe('unavailable');
    expect(vault.get('acc-dead')?.refreshDeadAtUtc).not.toBeNull();
  });
});
