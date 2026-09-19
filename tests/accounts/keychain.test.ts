import { describe, expect, test } from 'bun:test';
import {
  createMacosKeychain,
  KeychainError,
  parseKeychainPasswordOutput,
  type KeychainProcessRequest,
  type KeychainProcessResult,
  type KeychainProcessRunner,
} from '@llmtally/core/accounts/keychain.ts';

const SERVICE = 'llmtally';
const ACCOUNT = 'test-user';

type HelperBehavior =
  | 'success'
  | 'deny-before-write'
  | 'timeout-before-write'
  | 'timeout-after-write'
  | 'success-without-write'
  | 'write-third-value'
  | 'malformed-response';

function captureKeychainError(action: () => void): KeychainError {
  try {
    action();
  } catch (error) {
    if (error instanceof KeychainError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected KeychainError');
}

function createHarness(initial: string | null, behavior: HelperBehavior = 'success'): {
  readonly keychain: ReturnType<typeof createMacosKeychain>;
  readonly requests: KeychainProcessRequest[];
  readonly stored: () => string | null;
} {
  let stored = initial;
  let currentBehavior = behavior;
  const requests: KeychainProcessRequest[] = [];
  const runner: KeychainProcessRunner = (request): KeychainProcessResult => {
    requests.push(request);
    if (request.args.includes('--read') || request.args.includes('--find-account')) {
      const phase = request.args.includes('--read') ? 'read' : 'find-account';
      return { exitCode: stored === null ? 1 : 0, stdout: JSON.stringify({ version: 1, ok: stored !== null, phase, status: stored === null ? -25300 : 0, value: stored === null ? null : phase === 'read' ? stored : ACCOUNT }) };
    }
    if (request.args.includes('--remove')) {
      stored = null;
      return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, phase: 'remove', status: 0 }) };
    }
    if (request.executable === '/usr/bin/security') {
      if (request.args[0] === 'find-generic-password') {
        return stored === null
          ? { exitCode: 44, stdout: '', stderr: '' }
          : request.args.includes('-g')
            ? {
                exitCode: 0,
                stdout: `keychain: "/tmp/test.keychain-db"\n    "acct"<blob>="${ACCOUNT}"\n`,
                stderr: `password: "${stored}"\n`,
              }
            : {
                exitCode: 0,
                stdout: `keychain: "/tmp/test.keychain-db"\n    "acct"<blob>="${ACCOUNT}"\n`,
                stderr: '',
              };
      }
      if (request.args[0] === 'delete-generic-password') {
        stored = null;
        return { exitCode: 0, stdout: '' };
      }
      throw new Error(`unexpected security command: ${request.args[0] ?? 'missing'}`);
    }

    const input: unknown = JSON.parse(request.stdin ?? '');
    if (
      typeof input !== 'object' ||
      input === null ||
      !('secret' in input) ||
      typeof input.secret !== 'string'
    ) {
      throw new Error('invalid helper request');
    }
    const desired = input.secret;
    switch (currentBehavior) {
      case 'success':
        stored = desired;
        return { exitCode: 0, stdout: '{"version":1,"ok":true,"phase":"update","status":0}\n' };
      case 'deny-before-write':
        return { exitCode: 1, stdout: '{"version":1,"ok":false,"phase":"lookup","status":-25293}\n' };
      case 'timeout-before-write':
        return { exitCode: null, stdout: '' };
      case 'timeout-after-write':
        stored = desired;
        currentBehavior = 'success';
        return { exitCode: null, stdout: '' };
      case 'success-without-write':
        return { exitCode: 0, stdout: '{"version":1,"ok":true,"phase":"update","status":0}\n' };
      case 'write-third-value':
        stored = 'unexpected-third-value';
        return { exitCode: 1, stdout: '{"version":1,"ok":false,"phase":"update","status":-1}\n' };
      case 'malformed-response':
        return {
          exitCode: 1,
          stdout: JSON.stringify({ version: 1, ok: false, phase: desired, status: -1 }),
        };
    }
  };
  return {
    keychain: createMacosKeychain({
      helperPath: '/test/llmtally-keychain',
      keychainPath: '/tmp/test.keychain-db',
      runner,
    }),
    requests,
    stored: () => stored,
  };
}

describe('macOS keychain native writer', () => {
  test('security -g의 quoted ASCII hex token은 문자열 그대로 읽는다', () => {
    // Given
    const output = 'password: "deadbeef"\n';

    // When
    const parsed = parseKeychainPasswordOutput(output);

    // Then
    expect(parsed).toBe('deadbeef');
  });

  test('security -g의 marker 있는 hex bytes는 UTF-8 Unicode로 읽는다', () => {
    // Given
    const output = 'password: 0xED959C "\\355\\225\\234"\n';

    // When
    const parsed = parseKeychainPasswordOutput(output);

    // Then
    expect(parsed).toBe('한');
  });

  test('9492자와 64KiB secret을 native stdin으로 기록하고 정확히 read-back한다', () => {
    // Given
    const harness = createHarness('old');
    const largeSecrets = ['한글와 "quotes" \\ slash '.repeat(376).slice(0, 9492), 'x'.repeat(65_536)];

    for (const secret of largeSecrets) {
      // When
      harness.keychain.write(SERVICE, ACCOUNT, secret);

      // Then
      expect(harness.stored()).toBe(secret);
      const helperRequest = harness.requests.findLast(
        (request) => request.executable === '/test/llmtally-keychain' && !request.args.includes('--read'),
      );
      expect(helperRequest?.args).toEqual(['--keychain', '/tmp/test.keychain-db']);
      expect(helperRequest?.stdin).toBe(
        JSON.stringify({ version: 1, service: SERVICE, account: ACCOUNT, secret }),
      );
      expect(helperRequest?.timeoutMs).toBe(5000);
    }
  });

  test('native가 쓰기 전에 거부하고 이전 값이 확인되면 unchanged를 보고한다', () => {
    // Given
    const harness = createHarness('old', 'deny-before-write');

    // When
    const error = captureKeychainError(() => harness.keychain.write(SERVICE, ACCOUNT, 'new'));

    // Then
    expect(error.recovery).toBe('unchanged');
    expect(error.requiresInteraction).toBe(true);
    expect(harness.stored()).toBe('old');
  });

  test('pre-read 오류는 helper를 실행하지 않고 unchanged를 보고한다', () => {
    // Given
    const requests: KeychainProcessRequest[] = [];
    const runner: KeychainProcessRunner = (request) => {
      requests.push(request);
      return { exitCode: 1, stdout: '' };
    };
    const keychain = createMacosKeychain({ helperPath: '/test/helper', runner });

    // When
    try {
      keychain.write(SERVICE, ACCOUNT, 'new');
      throw new Error('expected keychain write to fail');
    } catch (error) {
      // Then
      expect(error).toBeInstanceOf(KeychainError);
      if (error instanceof KeychainError) {
        expect(error.recovery).toBe('unchanged');
      }
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args).toEqual(['--read']);
  });

  test('KeychainError의 recovery 기본값은 unknown이다', () => {
    // Given
    const message = 'uncertain';

    // When
    const error = new KeychainError(message);

    // Then
    expect(error.recovery).toBe('unknown');
  });

  test('timeout 전에 값이 바뀌지 않았으면 unchanged를 보고한다', () => {
    // Given
    const harness = createHarness('old', 'timeout-before-write');

    // When
    try {
      harness.keychain.write(SERVICE, ACCOUNT, 'new');
      throw new Error('expected keychain write to fail');
    } catch (error) {
      // Then
      expect(error).toBeInstanceOf(KeychainError);
      if (error instanceof KeychainError) {
        expect(error.recovery).toBe('unchanged');
      }
    }
    expect(harness.stored()).toBe('old');
  });

  test('timeout 뒤 원하는 값이 남으면 이전 값으로 rollback하고 restored를 보고한다', () => {
    // Given
    const harness = createHarness('old', 'timeout-after-write');

    // When
    try {
      harness.keychain.write(SERVICE, ACCOUNT, 'new');
      throw new Error('expected keychain write to fail');
    } catch (error) {
      // Then
      expect(error).toBeInstanceOf(KeychainError);
      if (error instanceof KeychainError) {
        expect(error.recovery).toBe('restored');
      }
    }
    expect(harness.stored()).toBe('old');
  });

  test('성공 응답 뒤 read-back이 이전 값이면 unchanged를 보고한다', () => {
    // Given
    const harness = createHarness('old', 'success-without-write');

    // When
    try {
      harness.keychain.write(SERVICE, ACCOUNT, 'new');
      throw new Error('expected keychain write to fail');
    } catch (error) {
      // Then
      expect(error).toBeInstanceOf(KeychainError);
      if (error instanceof KeychainError) {
        expect(error.recovery).toBe('unchanged');
      }
    }
    expect(harness.stored()).toBe('old');
  });

  test('native 실패 뒤 제3의 값이 보이면 덮어쓰지 않고 unknown을 보고한다', () => {
    // Given
    const harness = createHarness('old', 'write-third-value');

    // When
    try {
      harness.keychain.write(SERVICE, ACCOUNT, 'new');
      throw new Error('expected keychain write to fail');
    } catch (error) {
      // Then
      expect(error).toBeInstanceOf(KeychainError);
      if (error instanceof KeychainError) {
        expect(error.recovery).toBe('unknown');
      }
    }
    expect(harness.stored()).toBe('unexpected-third-value');
  });

  test('rollback도 실패하면 원하는 값이 남아도 unknown을 보고한다', () => {
    // Given
    let helperCalls = 0;
    let stored = 'old';
    const runner: KeychainProcessRunner = (request) => {
      if (request.args.includes('--read')) {
        return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, phase: 'read', status: 0, value: stored }) };
      }
      if (request.executable === '/usr/bin/security') {
        return stored === null
          ? { exitCode: 44, stdout: '', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: `password: "${stored}"\n` };
      }
      helperCalls += 1;
      if (helperCalls === 1) {
        stored = 'new';
      }
      return { exitCode: null, stdout: '' };
    };
    const keychain = createMacosKeychain({ helperPath: '/test/helper', runner });

    // When
    try {
      keychain.write(SERVICE, ACCOUNT, 'new');
      throw new Error('expected keychain write to fail');
    } catch (error) {
      // Then
      expect(error).toBeInstanceOf(KeychainError);
      if (error instanceof KeychainError) {
        expect(error.recovery).toBe('unknown');
      }
    }
    expect(stored).toBe('new');
    expect(helperCalls).toBe(2);
  });

  test('protocol 오류 메시지에 secret이나 raw output을 포함하지 않는다', () => {
    // Given
    const secret = 'SECRET-MUST-NOT-LEAK';
    const harness = createHarness('old', 'malformed-response');

    // When
    try {
      harness.keychain.write(SERVICE, ACCOUNT, secret);
      throw new Error('expected keychain write to fail');
    } catch (error) {
      // Then
      expect(error).toBeInstanceOf(KeychainError);
      if (error instanceof KeychainError) {
        expect(error.message).not.toContain(secret);
        expect(error.message).not.toContain('malformed:');
      }
    }
  });

  test('findAccount는 confirmed absent만 null이고 operational failure는 fail closed한다', () => {
    // Given
    const runner: KeychainProcessRunner = () => ({ exitCode: -1, stdout: '' });
    const keychain = createMacosKeychain({ helperPath: '/test/helper', runner });

    // When
    const error = captureKeychainError(() => keychain.findAccount(SERVICE));

    // Then
    expect(error.recovery).toBe('unchanged');
  });

  test('read/remove는 no-UI helper와 explicit keychain을 유지한다', () => {
    // Given
    const harness = createHarness('old');

    // When
    expect(harness.keychain.read(SERVICE, ACCOUNT)).toEqual({ kind: 'found', value: 'old' });
    harness.keychain.remove(SERVICE, ACCOUNT);

    // Then
    expect(harness.requests[0]?.args).toEqual(['--read', '--keychain', '/tmp/test.keychain-db']);
    expect(harness.requests[1]?.args).toEqual(['--remove', '--keychain', '/tmp/test.keychain-db']);
  });
});
