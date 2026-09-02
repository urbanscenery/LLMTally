import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  captureCursorCliAccount,
  serializeCursorCliVaultDocument,
} from '@llmtally/core/accounts/cursor-cli.ts';
import { spliceCursorCliConfig, switchCursorCliAccount } from '@llmtally/core/accounts/cursor-cli-switch.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_800_000_000;

function homeWith(live: {
  userId: string | number;
  email?: string;
  authId?: string;
  accessToken: string;
  refreshToken?: string;
  model?: string;
}): { home: string; vault: AccountVault; cooldownPath: string } {
  const home = makeTempDir();
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(
    join(home, '.cursor', 'cli-config.json'),
    JSON.stringify({
      authInfo: {
        userId: live.userId,
        email: live.email ?? 'live@example.com',
        authId: live.authId ?? 'auth-live',
        displayName: 'Live',
      },
      model: { modelId: live.model ?? 'keep-me' },
      approvalMode: 'allowlist',
      autoReviewAvailabilityCache: { authCacheKey: `auth:${live.authId ?? 'auth-live'}`, extra: 1 },
      serverConfigCache: { authCacheKey: `auth:${live.authId ?? 'auth-live'}`, backendUrl: 'https://api2.cursor.sh' },
    }),
  );
  writeFileSync(
    join(home, '.cursor', 'auth.json'),
    JSON.stringify({ accessToken: live.accessToken, refreshToken: live.refreshToken ?? 'live-refresh' }),
  );
  const vault = new AccountVault({ dir: join(home, 'vault'), keychain: createMemoryKeychain(false) });
  return { home, vault, cooldownPath: join(home, 'cooldown.json') };
}

const fakeLock = async () => ({ release(): void {} });

function putTarget(vault: AccountVault): void {
  vault.put(
    {
      agent: 'cursor-cli',
      accountId: '406',
      email: 'other@example.com',
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
      refreshDeadAtUtc: null,
    },
    serializeCursorCliVaultDocument({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      apiKey: null,
      authId: 'auth-target',
      email: 'other@example.com',
      displayName: 'Other',
      userId: '406',
      capturedAtUtc: NOW,
    }),
  );
}

describe('switchCursorCliAccount', () => {
  test('own: backs up the outgoing login onto its vault entry', async () => {
    const { home, vault, cooldownPath } = homeWith({ userId: 405, accessToken: 'live-access' });
    captureCursorCliAccount({ vault, home, fileStore: true, nowUtc: NOW });
    putTarget(vault);

    const result = await switchCursorCliAccount('406', {
      vault,
      home,
      nowUtc: NOW,
      fileStore: true,
      cooldownPath,
      acquireLock: fakeLock,
    });

    expect(result.outgoing).toBe('own');
    const config = JSON.parse(readFileSync(join(home, '.cursor', 'cli-config.json'), 'utf8')) as {
      authInfo: { userId: number; email: string };
      model: { modelId: string };
      approvalMode: string;
    };
    expect(config.authInfo.userId).toBe(406);
    expect(config.authInfo.email).toBe('other@example.com');
    expect(config.model.modelId).toBe('keep-me');
    expect(config.approvalMode).toBe('allowlist');
    const auth = JSON.parse(readFileSync(join(home, '.cursor', 'auth.json'), 'utf8')) as { accessToken: string };
    expect(auth.accessToken).toBe('target-access');
  });

  test('unclaimed: stashes a live login the vault has never seen', async () => {
    const { home, vault, cooldownPath } = homeWith({ userId: 405, accessToken: 'stranger-access' });
    putTarget(vault);

    const result = await switchCursorCliAccount('406', {
      vault,
      home,
      nowUtc: NOW,
      fileStore: true,
      cooldownPath,
      acquireLock: fakeLock,
    });

    expect(result.outgoing).toBe('unclaimed');
    expect(result.stashId).not.toBeNull();
    expect(vault.get('cursor-cli', '405')?.accountId).toBe('405');
  });

  test('CAS aborts when cli-config.json changes before the write', async () => {
    const { home, vault, cooldownPath } = homeWith({ userId: 405, accessToken: 'live-access' });
    captureCursorCliAccount({ vault, home, fileStore: true, nowUtc: NOW });
    putTarget(vault);

    await expect(
      switchCursorCliAccount('406', {
        vault,
        home,
        nowUtc: NOW,
        fileStore: true,
        cooldownPath,
        acquireLock: fakeLock,
        beforeWrite: () => {
          writeFileSync(join(home, '.cursor', 'cli-config.json'), '{"authInfo":{"userId":999}}');
        },
      }),
    ).rejects.toThrow(/changed while switching/);
    const config = JSON.parse(readFileSync(join(home, '.cursor', 'cli-config.json'), 'utf8')) as {
      authInfo: { userId: number };
    };
    expect(config.authInfo.userId).toBe(999);
  });

  test('rollback restores cli-config when the credential write fails', async () => {
    const { home, vault, cooldownPath } = homeWith({ userId: 405, accessToken: 'live-access' });
    captureCursorCliAccount({ vault, home, fileStore: true, nowUtc: NOW });
    putTarget(vault);
    const keychain = createMemoryKeychain();
    keychain.write = () => {
      throw new Error('keychain write failed');
    };

    await expect(
      switchCursorCliAccount('406', {
        vault,
        home,
        nowUtc: NOW,
        keychain,
        cooldownPath,
        acquireLock: fakeLock,
      }),
    ).rejects.toThrow(/keychain write failed/);
    const config = JSON.parse(readFileSync(join(home, '.cursor', 'cli-config.json'), 'utf8')) as {
      authInfo: { userId: number };
      model: { modelId: string };
    };
    expect(config.authInfo.userId).toBe(405);
    expect(config.model.modelId).toBe('keep-me');
  });

  test('refuses a refresh-dead entry', async () => {
    const { home, vault, cooldownPath } = homeWith({ userId: 405, accessToken: 'live-access' });
    vault.put(
      {
        agent: 'cursor-cli',
        accountId: '406',
        email: 'other@example.com',
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: NOW,
        refreshDeadAtUtc: NOW,
      },
      serializeCursorCliVaultDocument({
        accessToken: 'target-access',
        refreshToken: 'target-refresh',
        apiKey: null,
        authId: 'auth-target',
        email: 'other@example.com',
        displayName: 'Other',
        userId: '406',
        capturedAtUtc: NOW,
      }),
    );

    await expect(
      switchCursorCliAccount('406', {
        vault,
        home,
        nowUtc: NOW,
        fileStore: true,
        cooldownPath,
        acquireLock: fakeLock,
      }),
    ).rejects.toThrow(/cursor agent login/);
  });
});

describe('spliceCursorCliConfig', () => {
  test('leaves model fields untouched', () => {
    const next = spliceCursorCliConfig(
      {
        authInfo: { userId: 405, email: 'a@b.c', authId: 'old' },
        model: { modelId: 'keep-me' },
        privacyCache: { x: 1 },
      },
      {
        accessToken: 't',
        refreshToken: 'r',
        apiKey: null,
        authId: 'new-auth',
        email: 'n@n.n',
        displayName: 'N',
        userId: '406',
        capturedAtUtc: NOW,
      },
    );
    expect(next.model).toEqual({ modelId: 'keep-me' });
    expect(next.privacyCache).toEqual({ x: 1 });
    expect((next.authInfo as { userId: number }).userId).toBe(406);
  });
});
