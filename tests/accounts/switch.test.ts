import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireClaudeLocks, claudeLockSpecs } from '@llmtally/core/accounts/claude-locks.ts';
import { createActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import type { ActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import {
  captureActiveAccount,
  liveSessionPids,
  switchAccount,
} from '@llmtally/core/accounts/switch.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

function credentials(refresh: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `access-${refresh}`, refreshToken: refresh },
    ...extra,
  });
}

interface Harness {
  readonly home: string;
  readonly configHome: string;
  readonly configPath: string;
  readonly vault: AccountVault;
  readonly activeStore: ActiveCredentialStore;
  readonly locksHeld: () => number;
}

function makeHarness(activeUuid: string | null = 'uuid-1'): Harness {
  const home = makeTempDir();
  const configHome = join(home, '.claude');
  mkdirSync(configHome, { recursive: true });
  const configPath = join(home, '.claude.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        projects: { '/work': { history: ['keep me'] } },
        oauthAccount:
          activeUuid === null
            ? undefined
            : {
                accountUuid: activeUuid,
                emailAddress: `${activeUuid}@test.dev`,
                organizationUuid: 'org-1',
                organizationName: 'Org One',
              },
      },
      null,
      2,
    ),
  );
  const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain() });
  const activeStore = createActiveCredentialStore({
    configHome,
    keychain: createMemoryKeychain(),
    keychainAccount: 'me',
  });
  let held = 0;
  return {
    home,
    configHome,
    configPath,
    vault,
    activeStore,
    locksHeld: () => held,
  };
}

function ports(harness: Harness, overrides: Record<string, unknown> = {}) {
  return {
    vault: harness.vault,
    activeStore: harness.activeStore,
    home: harness.home,
    configHome: harness.configHome,
    nowUtc: NOW,
    acquireLocks: () => Promise.resolve({ release: () => undefined }),
    ...overrides,
  };
}

function seedAccount(harness: Harness, accountId: string, refresh: string): void {
  harness.vault.put(
    {
      agent: 'claude-code',
      accountId,
      email: `${accountId}@test.dev`,
      organizationUuid: 'org-1',
      organizationName: 'Org One',
      alias: null,
      addedAtUtc: NOW,
    },
    credentials(refresh),
  );
}

describe('switchAccount', () => {
  test('activates the target and splices only oauthAccount', async () => {
    // Arrange — uuid-1 is live, uuid-2 is stored
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-1', 'refresh-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    harness.vault.setActive('uuid-1');
    harness.activeStore.write(credentials('refresh-1'));

    // Act
    const result = await switchAccount('uuid-2@test.dev', ports(harness));

    // Assert
    expect(result.target.accountId).toBe('uuid-2');
    expect(JSON.parse(harness.activeStore.read() ?? '{}').claudeAiOauth.refreshToken).toBe('refresh-2');
    const config = JSON.parse(readFileSync(harness.configPath, 'utf8'));
    expect(config.oauthAccount.accountUuid).toBe('uuid-2');
    expect(config.oauthAccount.emailAddress).toBe('uuid-2@test.dev');
    expect(config.projects).toEqual({ '/work': { history: ['keep me'] } });
    expect(harness.vault.activeAccountId()).toBe('uuid-2');
  });

  test('the outgoing account is backed up before it is replaced', async () => {
    // Arrange — the live token rotated since it was stored
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-1', 'refresh-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    harness.activeStore.write(credentials('refresh-1', { trustedDeviceToken: 'device-1' }));

    // Act
    const result = await switchAccount('uuid-2', ports(harness));

    // Assert — the newer bytes replaced the stored snapshot for uuid-1
    expect(result.outgoing).toBe('own');
    const stored = JSON.parse(harness.vault.loadCredentials('uuid-1') ?? '{}');
    expect(stored.trustedDeviceToken).toBe('device-1');
  });

  test('credentials that match no stored account are stashed, not overwritten', async () => {
    // Arrange — live bytes belong to nobody the vault knows
    const harness = makeHarness('uuid-unknown');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    harness.activeStore.write(credentials('refresh-stranger'));

    // Act
    const result = await switchAccount('uuid-2', ports(harness));

    // Assert — nothing was clobbered and the bytes are recoverable
    expect(result.outgoing).toBe('unclaimed');
    expect(result.stashId).not.toBeNull();
    const stashed = readFileSync(
      join(harness.vault.directory, 'unclaimed', `${result.stashId}.cred`),
      'utf8',
    );
    expect(Buffer.from(stashed, 'base64').toString('utf8')).toBe(credentials('refresh-stranger'));
    expect(harness.vault.loadCredentials('uuid-2')).toBe(credentials('refresh-2'));
  });

  test('a signed-out live store never overwrites a stored snapshot', async () => {
    // Arrange — blank tokens, as Claude Code writes after invalid_grant
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-1', 'refresh-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    harness.activeStore.write(JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));

    // Act
    const result = await switchAccount('uuid-2', ports(harness));

    // Assert
    expect(result.outgoing).toBe('wiped');
    expect(harness.vault.loadCredentials('uuid-1')).toBe(credentials('refresh-1'));
    expect(result.warnings.some((warning) => warning.includes('blank'))).toBe(true);
  });

  test('a failure after the credential write is rolled back', async () => {
    // Arrange — the config file is unparseable, so the splice throws
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-1', 'refresh-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    harness.vault.setActive('uuid-1');
    harness.activeStore.write(credentials('refresh-1'));
    writeFileSync(harness.configPath, 'this is not json');

    // Act & Assert
    await expect(switchAccount('uuid-2', ports(harness))).rejects.toThrow('not valid JSON');
    expect(JSON.parse(harness.activeStore.read() ?? '{}').claudeAiOauth.refreshToken).toBe('refresh-1');
    expect(harness.vault.activeAccountId()).toBe('uuid-1');
  });

  test('a rollback with nothing previously live clears instead of leaving the target behind', async () => {
    // Arrange — no live credentials at all, and the config splice will fail
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-1', 'refresh-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    writeFileSync(harness.configPath, 'not json');

    // Act
    await expect(switchAccount('uuid-2', ports(harness))).rejects.toThrow('not valid JSON');

    // Assert — leaving uuid-2's token here would make a later "accounts
    // add" store it under uuid-1, destroying that account's backup
    expect(harness.activeStore.read()).toBeNull();
    expect(harness.vault.loadCredentials('uuid-1')).toBe(credentials('refresh-1'));
  });

  test('an account with no stored credentials is refused before anything changes', async () => {
    // Arrange
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    harness.vault.remove('uuid-2');
    harness.vault.put(
      {
        agent: 'claude-code',
        accountId: 'uuid-2',
        email: 'uuid-2@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
      },
      credentials('refresh-2'),
    );
    // drop just the credentials, keeping the registry entry
    const emptied = new AccountVault({
      dir: harness.vault.directory,
      keychain: createMemoryKeychain(),
    });

    // Act & Assert — the fresh keychain has no secret for this account
    await expect(switchAccount('uuid-2', ports(harness, { vault: emptied }))).rejects.toThrow(
      'no stored credentials',
    );
  });

  test('end to end with the real lock protocol and the file backend', async () => {
    // Arrange — no injected locks, so acquireClaudeLocks runs for real
    const home = makeTempDir();
    const configHome = join(home, '.claude');
    mkdirSync(configHome, { recursive: true });
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'uuid-1@test.dev' } }),
    );
    const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain(false) });
    const activeStore = createActiveCredentialStore({
      configHome,
      keychain: createMemoryKeychain(false),
    });
    activeStore.write(credentials('refresh-1'));
    for (const [accountId, refresh] of [
      ['uuid-1', 'refresh-1'],
      ['uuid-2', 'refresh-2'],
    ] as const) {
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
        credentials(refresh),
      );
    }

    // Act
    const result = await switchAccount('uuid-2', {
      vault,
      activeStore,
      home,
      configHome,
      nowUtc: NOW,
      lockTimeoutMs: 2000,
    });

    // Assert — switched, and every lock directory was cleaned up
    expect(result.backend).toBe('file');
    expect(JSON.parse(activeStore.read() ?? '{}').claudeAiOauth.refreshToken).toBe('refresh-2');
    expect(claudeLockSpecs(home, configHome).every((spec) => !existsSync(spec.path))).toBe(true);
  });

  test('the locks are always released, including on failure', async () => {
    // Arrange
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    harness.activeStore.write(credentials('refresh-1'));
    writeFileSync(harness.configPath, 'not json');
    let released = 0;

    // Act
    await expect(
      switchAccount(
        'uuid-2',
        ports(harness, {
          acquireLocks: () =>
            Promise.resolve({
              release: () => {
                released += 1;
              },
            }),
        }),
      ),
    ).rejects.toThrow();

    // Assert
    expect(released).toBe(1);
  });

  test('refuses to install a refresh-dead lineage and says how to recover', async () => {
    // Arrange — uuid-2's stored refresh token was rejected by the server
    const harness = makeHarness('uuid-1');
    seedAccount(harness, 'uuid-2', 'refresh-2');
    const { credentialFingerprint } = await import('@llmtally/core/accounts/credentials.ts');
    harness.vault.markRefreshDeadIfFingerprint(
      'uuid-2',
      credentialFingerprint(harness.vault.loadCredentials('uuid-2') ?? ''),
      NOW,
    );
    harness.activeStore.write(credentials('refresh-1'));

    // Act & Assert — fail before any store is touched
    await expect(switchAccount('uuid-2', ports(harness))).rejects.toThrow(/\/login as that account/);
    expect(JSON.parse(harness.activeStore.read() ?? '{}').claudeAiOauth.refreshToken).toBe(
      'refresh-1',
    );
  });
});

describe('captureActiveAccount', () => {
  test('stores the logged-in account and marks it active', () => {
    // Arrange
    const harness = makeHarness('uuid-1');
    harness.activeStore.write(credentials('refresh-1'));

    // Act
    const entry = captureActiveAccount({
      vault: harness.vault,
      activeStore: harness.activeStore,
      home: harness.home,
      alias: 'work',
      nowUtc: NOW,
    });

    // Assert
    expect(entry.accountId).toBe('uuid-1');
    expect(entry.email).toBe('uuid-1@test.dev');
    expect(harness.vault.activeAccountId()).toBe('uuid-1');
    expect(harness.vault.loadCredentials('uuid-1')).toBe(credentials('refresh-1'));
  });

  test('refuses when nothing is logged in or the store is empty', () => {
    // Arrange
    const withoutLogin = makeHarness(null);
    withoutLogin.activeStore.write(credentials('refresh-1'));
    const withoutCredentials = makeHarness('uuid-1');

    // Act & Assert
    expect(() =>
      captureActiveAccount({
        vault: withoutLogin.vault,
        activeStore: withoutLogin.activeStore,
        home: withoutLogin.home,
      }),
    ).toThrow('no logged-in Claude Code account');
    expect(() =>
      captureActiveAccount({
        vault: withoutCredentials.vault,
        activeStore: withoutCredentials.activeStore,
        home: withoutCredentials.home,
      }),
    ).toThrow('could not read the active');
  });
});

describe('claude lock protocol', () => {
  test('locks are acquired in Claude Code order and released together', async () => {
    // Arrange
    const home = makeTempDir();
    const configHome = join(home, '.claude');
    mkdirSync(configHome, { recursive: true });
    const specs = claudeLockSpecs(home, configHome);

    // Act
    const handle = await acquireClaudeLocks({ home, configHome });
    const heldDuring = specs.filter((spec) => existsSync(spec.path)).length;
    handle.release();

    // Assert
    expect(specs.map((spec) => spec.path.split('/').pop())).toEqual([
      '.oauth_refresh.lock',
      '.claude.lock',
      '.claude.json.lock',
    ]);
    expect(heldDuring).toBe(3);
    expect(specs.every((spec) => !existsSync(spec.path))).toBe(true);
  });

  test('a fresh lock held by someone else times out instead of stealing it', async () => {
    // Arrange — hold the first lock with a current mtime
    const home = makeTempDir();
    const configHome = join(home, '.claude');
    mkdirSync(configHome, { recursive: true });
    mkdirSync(join(configHome, '.oauth_refresh.lock'), { recursive: true });

    // Act & Assert
    await expect(acquireClaudeLocks({ home, configHome, timeoutMs: 150 })).rejects.toThrow(
      'timed out waiting',
    );
  });

  test('a stale lock is reclaimed', async () => {
    // Arrange — a lock whose mtime is well past the staleness window
    const home = makeTempDir();
    const configHome = join(home, '.claude');
    mkdirSync(configHome, { recursive: true });
    const stale = join(configHome, '.oauth_refresh.lock');
    mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);

    // Act
    const handle = await acquireClaudeLocks({ home, configHome, timeoutMs: 500 });
    handle.release();

    // Assert
    expect(existsSync(stale)).toBe(false);
  });

  test('a partial acquisition does not leak the locks it already took', async () => {
    // Arrange — the last lock in the order is held by someone else
    const home = makeTempDir();
    const configHome = join(home, '.claude');
    mkdirSync(configHome, { recursive: true });
    mkdirSync(join(home, '.claude.json.lock'), { recursive: true });

    // Act
    await expect(acquireClaudeLocks({ home, configHome, timeoutMs: 150 })).rejects.toThrow();

    // Assert — the earlier two were released
    expect(existsSync(join(configHome, '.oauth_refresh.lock'))).toBe(false);
    expect(existsSync(join(home, '.claude.lock'))).toBe(false);
  });
});

describe('liveSessionPids', () => {
  test('reports this process from an ide lock file and ignores dead pids', () => {
    // Arrange
    const configHome = makeTempDir();
    mkdirSync(join(configHome, 'ide'), { recursive: true });
    writeFileSync(
      join(configHome, 'ide', '1234.lock'),
      JSON.stringify({ pid: process.pid, ideName: 'Visual Studio Code' }),
    );
    writeFileSync(join(configHome, 'ide', '9999.lock'), JSON.stringify({ pid: 2_147_483_600 }));

    // Act & Assert
    expect(liveSessionPids(configHome)).toEqual([process.pid]);
  });

  test('no lock directory means no sessions', () => {
    // Act & Assert
    expect(liveSessionPids(join(makeTempDir(), 'none'))).toEqual([]);
  });
});

