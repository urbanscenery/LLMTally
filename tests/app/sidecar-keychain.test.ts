import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSidecarServer } from '@llmtally/app/sidecar-main.ts';
import { createActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

test('switchAccount RPC uses the injected Claude switch ports', async () => {
  // Given: an isolated vault, active store, and config owned by the test.
  const home = makeTempDir();
  const configHome = join(home, '.claude');
  const vaultDir = join(home, 'vault');
  mkdirSync(configHome, { recursive: true });
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: 'account-a' }, keep: 'unchanged' }),
  );
  const keychain = createMemoryKeychain();
  const vault = new AccountVault({ dir: vaultDir, keychain });
  const activeStore = createActiveCredentialStore({
    configHome,
    keychain,
    keychainAccount: 'synthetic-user',
  });
  const credential = (account: string): string =>
    JSON.stringify({ claudeAiOauth: { accessToken: `access-${account}`, refreshToken: account } });
  for (const accountId of ['account-a', 'account-b']) {
    vault.put(
      {
        agent: 'claude-code',
        accountId,
        email: `${accountId}@test.invalid`,
        organizationUuid: null,
        organizationName: null,
        alias: null,
        addedAtUtc: 1_786_400_000,
      },
      credential(accountId),
    );
  }
  vault.setActive('claude-code', 'account-a');
  activeStore.write(credential('account-a'));
  let interactions = 0;
  const server = createSidecarServer({
    databasePath: join(home, 'unused.db'),
    vaultDir,
    claudeSwitchPorts: {
      vault,
      activeStore,
      home,
      configHome,
      acquireLocks: () => Promise.resolve({ release: () => undefined }),
    },
    keychainInteraction: (callback) => {
      interactions += 1;
      return callback();
    },
  });

  // When: the App-facing JSON-RPC method switches to account B.
  const response = await server.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'switchAccount',
      params: { agent: 'claude-code', selector: 'account-b' },
    }),
  );

  // Then: the injected ports, config, and marker all agree on account B.
  const reply: unknown = response === null ? null : JSON.parse(response);
  expect(reply).toMatchObject({ result: { target: { accountId: 'account-b' } } });
  expect(JSON.parse(activeStore.read() ?? '{}').claudeAiOauth.refreshToken).toBe('account-b');
  expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).oauthAccount.accountUuid).toBe(
    'account-b',
  );
  expect(vault.activeAccountId('claude-code')).toBe('account-b');
  expect(interactions).toBe(1);

  const authorization = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'authorizeKeychain' }),
  );
  const authorizationReply: unknown = authorization === null ? null : JSON.parse(authorization);
  expect(authorizationReply).toEqual({
    jsonrpc: '2.0',
    id: 2,
    result: { storedAccounts: 2, activeCredential: true },
  });
  expect(authorization).not.toContain('access-account');
  expect(interactions).toBe(2);

  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'activeAccounts' }),
  );
  expect(interactions).toBe(2);
});
