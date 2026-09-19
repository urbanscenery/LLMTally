import type { KeychainProcessRunner } from './keychain-native.ts';
import type { KeychainReadResult } from './keychain-types.ts';

type Operation = 'read' | 'find-account' | 'remove';

export function invokeKeychainQuery(
  helperPath: string,
  keychainPath: string | undefined,
  runner: KeychainProcessRunner,
  operation: Operation,
  service: string,
  account: string,
  interactive = false,
): KeychainReadResult {
  const args = [`--${operation}`];
  if (interactive && operation === 'read') args.push('--allow-ui');
  if (keychainPath !== undefined) args.push('--keychain', keychainPath);
  try {
    const result = runner({
      executable: helperPath,
      args,
      stdin: JSON.stringify({ version: 1, service, account }),
      timeoutMs: interactive ? 120_000 : 5000,
    });
    const value: unknown = JSON.parse(result.stdout);
    if (
      typeof value !== 'object' || value === null ||
      !('version' in value) || value.version !== 1 ||
      !('phase' in value) || value.phase !== operation ||
      !('ok' in value) || typeof value.ok !== 'boolean' ||
      !('status' in value) || typeof value.status !== 'number' || !Number.isInteger(value.status) ||
      Object.keys(value).sort().join(',') !== (operation === 'remove' ? 'ok,phase,status,version' : 'ok,phase,status,value,version')
    ) return { kind: 'error', message: 'Keychain helper returned an invalid response' };
    if (result.exitCode === 0 && value.ok && value.status === 0) {
      if (operation === 'remove') return { kind: 'absent' };
      if ('value' in value && typeof value.value === 'string') {
        return value.value.length === 0 ? { kind: 'absent' } : { kind: 'found', value: value.value };
      }
    }
    if (result.exitCode === 1 && !value.ok && 'value' in value && value.value === null) {
      if (value.status === -25300) return { kind: 'absent' };
      if ([-25308, -25293, -128].includes(value.status)) {
        return {
          kind: 'error',
          requiresInteraction: true,
          message: 'Keychain access requires approval. Choose Authorize Keychain in Accounts.',
        };
      }
    }
    return { kind: 'error', message: `Keychain ${operation} failed (status ${value.status})` };
  } catch (error) {
    if (error instanceof Error) return { kind: 'error', message: `Keychain ${operation} could not complete` };
    throw error;
  }
}
