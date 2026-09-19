import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSidecarServer } from '../packages/app/src/sidecar-main.ts';
import {
  ACTIVE_KEYCHAIN_SERVICE,
  activeKeychainService,
  createActiveCredentialStore,
} from '../packages/core/src/accounts/credentials.ts';
import { defaultKeychainProcessRunner } from '../packages/core/src/accounts/keychain-native.ts';
import type { KeychainProcessResult, KeychainProcessRunner } from '../packages/core/src/accounts/keychain-native.ts';
import { switchAccount } from '../packages/core/src/accounts/switch.ts';
import type { SwitchPorts } from '../packages/core/src/accounts/switch.ts';
import { AccountVault } from '../packages/core/src/accounts/vault.ts';
import { runAdapterFaultQa } from './keychain-switch-qa-faults.ts';
import {
  assertState,
  credential,
  execute,
  expectFailure,
  parseRecord,
  requireSuccess,
  rpcResultAccount,
  serviceFromRequest,
  stateFingerprint,
} from './keychain-switch-qa-support.ts';
import type { SwitchQaOptions } from './keychain-switch-qa-support.ts';

const PASSWORD = 'llmtally-synthetic-switch-password';
const ACCOUNT = 'llmtally-switch-qa';
const NOW = 1_786_400_000;
function addAccounts(vault: AccountVault, a: string, b: string): void {
  for (const [accountId, text] of [
    ['account-a', a],
    ['account-b', b],
  ] as const) {
    vault.put(
      {
        agent: 'claude-code',
        accountId,
        email: `${accountId}@test.invalid`,
        organizationUuid: `org-${accountId}`,
        organizationName: `조직 "${accountId}" \\ QA`,
        alias: null,
        addedAtUtc: NOW,
      },
      text,
    );
  }
}

export async function runKeychainSwitchQa(options: SwitchQaOptions): Promise<void> {
  const originalFingerprint = stateFingerprint();
  const workDir = requireSuccess('mktemp', execute(['/usr/bin/mktemp', '-d', join(tmpdir(), 'llmtally-switch-XXXXXX')]));
  const keychainPath = join(workDir, 'isolated.keychain-db');
  const testHelper = join(workDir, 'llmtally-keychain-test-support');
  let created = false;
  let cleanupFailure: string | null = null;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    requireSuccess(
      'compile test support',
      execute([
        'xcrun', 'swiftc', '-suppress-warnings', '-D', 'LLMTALLY_KEYCHAIN_TESTING',
        '-framework', 'Foundation', '-framework', 'LocalAuthentication', '-framework', 'Security',
        join(options.sourceRoot, 'main.swift'), join(options.sourceRoot, 'TestSupport.swift'), '-o', testHelper,
      ], undefined, 60_000),
    );
    requireSuccess('create isolated keychain', execute([testHelper, '--test-create-keychain', keychainPath], PASSWORD));
    created = true;
    if (stateFingerprint() !== originalFingerprint) {
      throw new Error('isolated keychain creation changed user keychain state');
    }
    const home = join(workDir, 'home');
    const configHome = join(home, '.claude');
    const configPath = join(home, '.claude.json');
    const vaultDir = join(home, 'vault');
    mkdirSync(configHome, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = home;
    const mcp = { provider: '한글 "quoted" \\ path', tokenShape: { length: 64, retained: true } };
    const staleMcp = { provider: '구형 "quoted" \\ path', tokenShape: { length: 65, retained: true } };
    const credentialA = credential(9_492, 'a', mcp);
    const credentialB = credential(65_536, 'b', staleMcp);
    let secretInArgv = false;
    let interactiveNativeReads = 0;
    let backgroundNativeReads = 0;
    let externalReaderChecks = 0;
    const auditedRunner: KeychainProcessRunner = (request): KeychainProcessResult => {
      const argv = [request.executable, ...request.args].join('\0');
      secretInArgv ||= ['access-a', 'access-b', 'refresh-a', 'refresh-b', '한글', 'quoted'].some(
        (fragment) => argv.includes(fragment),
      );
      if (request.executable === options.helperPath && request.args.includes('--read')) {
        if (request.args.includes('--allow-ui')) interactiveNativeReads += 1;
        else backgroundNativeReads += 1;
      }
      if (request.executable === '/usr/bin/security' && request.args.includes('-g')) {
        externalReaderChecks += 1;
      }
      return defaultKeychainProcessRunner(request);
    };
    const keychain = options.createMacosKeychain({
      helperPath: options.helperPath, keychainPath, runner: auditedRunner,
    });
    const vault = new AccountVault({ dir: vaultDir, keychain });
    const activeStore = createActiveCredentialStore({ configHome, keychain, keychainAccount: ACCOUNT });
    const ports: SwitchPorts = {
      vault, activeStore, home, configHome, nowUtc: NOW,
      acquireLocks: () => Promise.resolve({ release: () => undefined }),
    };
    writeFileSync(configPath, JSON.stringify({ keep: { nested: true }, oauthAccount: { accountUuid: 'account-a' } }));
    addAccounts(vault, credentialA, credentialB);
    vault.setActive('claude-code', 'account-a');
    options.withKeychainInteraction(() => activeStore.write(credentialA));
    await options.withKeychainInteraction(() => switchAccount('account-b', ports));
    assertState('CLI A-to-B', ports, configPath, 'account-b', 65_536, mcp);
    const server = createSidecarServer({ databasePath: join(home, 'unused.db'), vaultDir, claudeSwitchPorts: ports });
    const rpcResponse = await options.withKeychainInteraction(() =>
      server.handleLine(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'switchAccount',
        params: { agent: 'claude-code', selector: 'account-a' },
      })));
    if (rpcResultAccount(rpcResponse) !== 'account-a') {
      throw new Error('App switchAccount RPC did not return account A');
    }
    assertState('App RPC B-to-A', ports, configPath, 'account-a', 9_492, mcp);
    await options.withKeychainInteraction(() => switchAccount('account-a', ports));
    assertState('repeat A', ports, configPath, 'account-a', 9_492, mcp);
    const beforeConfigFailure = activeStore.read();
    writeFileSync(configPath, '{');
    await expectFailure('config failure', () =>
      options.withKeychainInteraction(() => switchAccount('account-b', ports)));
    if (activeStore.read() !== beforeConfigFailure || vault.activeAccountId('claude-code') !== 'account-a') {
      throw new Error('config failure did not restore the native credential and marker');
    }
    writeFileSync(configPath, JSON.stringify({ keep: { nested: true }, oauthAccount: { accountUuid: 'account-a' } }));
    let injectSecondServiceFailure = false;
    const failingRunner: KeychainProcessRunner = (request): KeychainProcessResult => {
      if (
        injectSecondServiceFailure &&
        request.executable === options.helperPath &&
        !request.args.some((arg) =>
          arg === '--read' || arg === '--remove' || arg === '--find-account') &&
        serviceFromRequest(request) === ACTIVE_KEYCHAIN_SERVICE
      ) {
        return { exitCode: 1, stdout: '{"version":1,"ok":false,"phase":"update","status":-25293}\n' };
      }
      return auditedRunner(request);
    };
    const transactionalKeychain = options.createMacosKeychain({
      helperPath: options.helperPath, keychainPath, runner: failingRunner,
    });
    const transactionalStore = createActiveCredentialStore({
      configHome, keychain: transactionalKeychain, keychainAccount: 'second-service-user',
    });
    options.withKeychainInteraction(() => transactionalStore.write(credentialA));
    injectSecondServiceFailure = true;
    await expectFailure('second service failure', async () => {
      options.withKeychainInteraction(() => transactionalStore.write(credentialB));
    });
    if (transactionalStore.read() !== credentialA) {
      throw new Error('second service failure did not restore the first native service');
    }
    const readFailureRunner: KeychainProcessRunner = (request): KeychainProcessResult =>
      request.executable === options.helperPath && request.args.includes('--read')
        ? {
            exitCode: 1,
            stdout: JSON.stringify({
              version: 1, ok: false, phase: 'read', status: -25308, value: null,
            }),
          }
        : auditedRunner(request);
    const unreadableStore = createActiveCredentialStore({
      configHome,
      keychain: options.createMacosKeychain({
        helperPath: options.helperPath, keychainPath, runner: readFailureRunner,
      }),
      keychainAccount: ACCOUNT,
    });
    await expectFailure('keychain read failure', () =>
      options.withKeychainInteraction(() =>
        switchAccount('account-b', { ...ports, activeStore: unreadableStore })));
    assertState('read failure', ports, configPath, 'account-a', 9_492, mcp);
    const scopedService = activeKeychainService(configHome, home);
    if (keychain.read(scopedService, ACCOUNT).kind !== 'found' || existsSync(join(configHome, '.credentials.json'))) {
      throw new Error('native active credential or plaintext absence verification failed');
    }
    if (secretInArgv) {
      throw new Error('synthetic credential data appeared in a process argument');
    }
    if (interactiveNativeReads === 0 || backgroundNativeReads === 0 || externalReaderChecks === 0) {
      throw new Error('interactive/background/external-reader partition was not exercised');
    }
    runAdapterFaultQa({
      createMacosKeychain: options.createMacosKeychain,
      withKeychainInteraction: options.withKeychainInteraction,
      helperPath: options.helperPath,
      keychainPath,
      actualRunner: auditedRunner,
    });
  } finally {
    if (created) {
      const deletion = execute([testHelper, '--test-delete-keychain', keychainPath]);
      const deletionBody = parseRecord(deletion.stdout);
      if (deletion.exitCode !== 0 || deletionBody?.ok !== true || existsSync(keychainPath)) {
        cleanupFailure = `isolated keychain deletion failed with exit ${deletion.exitCode}`;
      }
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    rmSync(workDir, { recursive: true, force: true });
    if (stateFingerprint() !== originalFingerprint) {
      throw new Error('actual user keychain state changed during cleanup');
    }
    if (cleanupFailure !== null) {
      throw new Error(cleanupFailure);
    }
  }
  process.stdout.write(JSON.stringify({
    artifact: options.artifact,
    helperExecutable: existsSync(options.helperPath),
    cliSwitch: true,
    appRpcSwitch: true,
    lengths: [9_492, 65_536],
    mcpPreserved: true,
    configMarkerAligned: true,
    repeatedStateStable: true,
    secondServiceRollback: true,
    configRollback: true,
    readFailureInjected: true,
    interactiveReadContext: true,
    backgroundReadNoUi: true,
    externalReaderVerified: true,
    writerFaultPartitioned: true,
    deniedBeforeWriteUnchanged: true,
    timeoutAfterWriteRestored: true,
    killedAfterWriteRestored: true,
    thirdValueUnknown: true,
    plaintextCredentialAbsent: true,
    secretAbsentFromArgv: true,
    userKeychainStateUnchanged: true,
    cleanupVerified: true,
  }) + '\n');
}
