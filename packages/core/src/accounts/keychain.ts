import { isKeychainInteractionAllowed } from './keychain-interaction.ts';
import { invokeKeychainQuery } from './keychain-query.ts';
export { withKeychainInteraction } from './keychain-interaction.ts';
import {
  defaultKeychainProcessRunner,
  invokeNativeWrite,
  resolveKeychainHelperPath,
} from './keychain-native.ts';
import type {
  KeychainProcessRequest,
  KeychainProcessResult,
  KeychainProcessRunner,
} from './keychain-native.ts';
import { KeychainError } from './keychain-types.ts';
import type { KeychainPort, KeychainReadResult } from './keychain-types.ts';
import {
  interpretSecurityRead,
  parseKeychainPasswordOutput,
} from './keychain-security.ts';

const SECURITY_BIN = '/usr/bin/security';
const INTERACTIVE_TIMEOUT_MS = 120_000;
const BACKGROUND_TIMEOUT_MS = 5000;
/** The only service this app owns; every other item belongs to an external CLI. */
const OWN_SERVICE = 'llmtally';
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]');

export type { KeychainProcessRequest, KeychainProcessResult, KeychainProcessRunner };
export { KeychainError, keychainValue } from './keychain-types.ts';
export type { KeychainPort, KeychainReadResult, KeychainRecovery } from './keychain-types.ts';
export { parseAccountAttribute, parseKeychainPasswordOutput } from './keychain-security.ts';

export interface MacosKeychainOptions {
  readonly helperPath?: string;
  readonly keychainPath?: string;
  readonly runner?: KeychainProcessRunner;
}

export function createMacosKeychain(options: MacosKeychainOptions = {}): KeychainPort {
  const runner = options.runner ?? defaultKeychainProcessRunner;
  const helperPath = options.helperPath ?? resolveKeychainHelperPath();
  const available = options.runner !== undefined || process.platform === 'darwin';
  const securityArgs = (args: readonly string[]): readonly string[] =>
    options.keychainPath === undefined ? args : [...args, options.keychainPath];
  const runSecurity = (
    args: readonly string[],
    timeoutMs: number = INTERACTIVE_TIMEOUT_MS,
  ): KeychainProcessResult => {
    try {
      return runner({ executable: SECURITY_BIN, args: securityArgs(args), timeoutMs });
    } catch (error) {
      if (error instanceof Error) {
        return { exitCode: null, stdout: '' };
      }
      throw error;
    }
  };

  const keychain: KeychainPort = {
    available,
    read(service, account) {
      if (!available) {
        return { kind: 'absent' };
      }
      const interactive = isKeychainInteractionAllowed();
      if (service !== OWN_SERVICE) {
        // Items another CLI owns (Claude Code, Cursor) are (re)written
        // by /usr/bin/security, which resets their partition list to
        // `apple-tool:` on every token refresh. The ad-hoc helper's
        // cdhash partition never survives that, so read them with the
        // one client the item always trusts.
        return interpretSecurityRead(
          runSecurity(
            ['find-generic-password', '-s', service, '-a', account, '-g'],
            interactive ? INTERACTIVE_TIMEOUT_MS : BACKGROUND_TIMEOUT_MS,
          ),
        );
      }
      return invokeKeychainQuery(helperPath, options.keychainPath, runner, 'read', service, account, interactive);
    },
    write(service, account, secret) {
      if (!available) {
        throw new KeychainError('keychain is only available on macOS', 'unchanged');
      }
      for (const [name, value] of [
        ['service', service],
        ['account', account],
        ['secret', secret],
      ] as const) {
        if (CONTROL_CHARACTERS.test(value)) {
          throw new KeychainError(
            `keychain ${name} must not contain control characters`,
            'unchanged',
          );
        }
      }
      const externalReader = service !== OWN_SERVICE;
      if (externalReader && !isKeychainInteractionAllowed()) {
        throw new KeychainError('Shared credentials can only be changed by an explicit account action', 'unchanged');
      }
      const previous = keychain.read(service, account);
      if (previous.kind === 'error') {
        throw new KeychainError(
          `refusing to write: the existing keychain item could not be read (${previous.message})`,
          'unchanged',
          previous.requiresInteraction ?? false,
        );
      }
      if (matchesSecret(previous, secret)) {
        if (!externalReader || verifyExternalReader(service, account, secret, runSecurity)) return;
        throw new KeychainError('Existing credentials could not be verified by the external reader', 'unchanged');
      }
      const writeResult = invokeNativeWrite(
        helperPath,
        options.keychainPath,
        { service, account, secret },
        runner,
      );
      const readBack = keychain.read(service, account);
      const requiresInteraction =
        (writeResult.kind === 'failure' && writeResult.requiresInteraction === true) ||
        (readBack.kind === 'error' && readBack.requiresInteraction === true);
      if (writeResult.kind === 'success' && matchesSecret(readBack, secret)) {
        if (!externalReader || verifyExternalReader(service, account, secret, runSecurity)) return;
      }
      const failureMessage =
        writeResult.kind === 'failure'
          ? writeResult.message
          : 'keychain write did not pass exact reader verification';
      if (sameSnapshot(previous, readBack)) {
        throw new KeychainError(`${failureMessage}; the item was left unchanged`, 'unchanged', requiresInteraction);
      }
      if (!matchesSecret(readBack, secret)) {
        throw new KeychainError(
          `${failureMessage}; the keychain state is unknown and was not overwritten`,
          'unknown',
          requiresInteraction,
        );
      }
      const restoration = restoreSnapshot(
        keychain,
        helperPath,
        options.keychainPath,
        runner,
        service,
        account,
        previous,
      );
      const restored = restoration.restored &&
        (!externalReader || previous.kind === 'absent' || verifyExternalReader(service, account, previous.value, runSecurity));
      throw new KeychainError(
        restored
          ? `${failureMessage}; the previous value was restored`
          : `${failureMessage}; the previous value could not be restored`,
        restored ? 'restored' : 'unknown',
        requiresInteraction || restoration.requiresInteraction,
      );
    },
    remove(service, account) {
      if (!available) {
        return;
      }
      const result = invokeKeychainQuery(helperPath, options.keychainPath, runner, 'remove', service, account);
      if (result.kind === 'error') throw new KeychainError(result.message, 'unknown', result.requiresInteraction ?? false);
    },
    findAccount(service) {
      if (!available) {
        return null;
      }
      const result = invokeKeychainQuery(helperPath, options.keychainPath, runner, 'find-account', service, '');
      if (result.kind === 'error') throw new KeychainError(result.message, 'unchanged', result.requiresInteraction ?? false);
      return result.kind === 'found' ? result.value : null;
    },
  };
  return keychain;
}

function verifyExternalReader(
  service: string,
  account: string,
  expected: string,
  run: (args: readonly string[]) => KeychainProcessResult,
): boolean {
  const result = run(['find-generic-password', '-s', service, '-a', account, '-g']);
  return result.exitCode === 0 && parseKeychainPasswordOutput(result.stderr ?? '') === expected;
}

function matchesSecret(result: KeychainReadResult, secret: string): boolean {
  return result.kind === 'found' && result.value === secret;
}

function sameSnapshot(previous: KeychainReadResult, current: KeychainReadResult): boolean {
  if (previous.kind === 'absent') {
    return current.kind === 'absent';
  }
  return previous.kind === 'found' && current.kind === 'found' && previous.value === current.value;
}

function restoreSnapshot(
  keychain: KeychainPort,
  helperPath: string,
  keychainPath: string | undefined,
  runner: KeychainProcessRunner,
  service: string,
  account: string,
  previous: Exclude<KeychainReadResult, { readonly kind: 'error' }>,
): { readonly restored: boolean; readonly requiresInteraction: boolean } {
  let requiresInteraction = false;
  if (previous.kind === 'found') {
    const result = invokeNativeWrite(helperPath, keychainPath, { service, account, secret: previous.value }, runner);
    requiresInteraction = result.kind === 'failure' && result.requiresInteraction === true;
  } else {
    try {
      keychain.remove(service, account);
    } catch (error) {
      if (!(error instanceof KeychainError)) throw error;
      requiresInteraction = error.requiresInteraction;
    }
  }
  const current = keychain.read(service, account);
  return {
    restored: sameSnapshot(previous, current),
    requiresInteraction: requiresInteraction || (current.kind === 'error' && current.requiresInteraction === true),
  };
}

export const macosKeychain: KeychainPort = createMacosKeychain();

export function createMemoryKeychain(
  available = true,
  maxSecretLength = Number.POSITIVE_INFINITY,
): KeychainPort {
  const services = new Map<string, Map<string, string>>();
  return {
    available,
    read(service, account) {
      const value = services.get(service)?.get(account);
      return value === undefined ? { kind: 'absent' } : { kind: 'found', value };
    },
    write(service, account, secret) {
      if (!available) {
        throw new KeychainError('keychain unavailable', 'unchanged');
      }
      if (secret.length > maxSecretLength) {
        throw new KeychainError('secret is too large for the keychain CLI', 'unchanged');
      }
      const accounts = services.get(service) ?? new Map<string, string>();
      accounts.set(account, secret);
      services.set(service, accounts);
    },
    remove(service, account) {
      services.get(service)?.delete(account);
    },
    findAccount(service) {
      const first = services.get(service)?.keys().next();
      return first === undefined || first.done === true ? null : first.value;
    },
  };
}
