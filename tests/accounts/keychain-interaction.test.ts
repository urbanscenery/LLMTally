import { expect, test } from 'bun:test';
import { createMacosKeychain, withKeychainInteraction } from '@llmtally/core/accounts/keychain.ts';
import type { KeychainProcessRequest } from '@llmtally/core/accounts/keychain.ts';

test('background reads never start an interactive security process', () => {
  const requests: KeychainProcessRequest[] = [];
  const keychain = createMacosKeychain({
    helperPath: '/test/helper',
    runner(request) {
      requests.push(request);
      return { exitCode: 1, stdout: JSON.stringify({ version: 1, ok: false, phase: 'read', status: -25308, value: null }) };
    },
  });
  const result = keychain.read('llmtally', 'test');
  expect(result.kind).toBe('error');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.executable).toBe('/test/helper');
  expect(requests[0]?.args).toEqual(['--read']);
});

test('explicit authorization survives async work without leaking to background reads', async () => {
  const requests: KeychainProcessRequest[] = [];
  const keychain = createMacosKeychain({
    helperPath: '/test/helper',
    runner(request) {
      requests.push(request);
      return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, phase: 'read', status: 0, value: 'opaque' }) };
    },
  });
  await withKeychainInteraction(async () => {
    await Promise.resolve();
    expect(keychain.read('llmtally', 'test')).toEqual({ kind: 'found', value: 'opaque' });
  });
  keychain.read('llmtally', 'test');
  expect(requests[0]?.args).toEqual(['--read', '--allow-ui']);
  expect(requests[0]?.timeoutMs).toBe(120_000);
  expect(requests[1]?.args).toEqual(['--read']);
  expect(requests[1]?.timeoutMs).toBe(5000);
});

function sharedCredentialHarness(externalStatus = 0) {
  let stored = 'old';
  const requests: KeychainProcessRequest[] = [];
  const keychain = createMacosKeychain({
    helperPath: '/test/helper',
    runner(request) {
      requests.push(request);
      if (request.executable === '/usr/bin/security') {
        return { exitCode: externalStatus, stdout: '', stderr: `password: "${stored}"\n` };
      }
      if (request.args.includes('--read')) {
        return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, phase: 'read', status: 0, value: stored }) };
      }
      const input: unknown = JSON.parse(request.stdin ?? '');
      if (typeof input !== 'object' || input === null || !('secret' in input) || typeof input.secret !== 'string') {
        throw new Error('invalid test write');
      }
      stored = input.secret;
      return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, phase: 'update', status: 0 }) };
    },
  });
  return { keychain, requests, stored: () => stored };
}

test('background cannot change credentials consumed by external clients', () => {
  const harness = sharedCredentialHarness();
  expect(() => harness.keychain.write('Claude Code-credentials', 'test', 'new')).toThrow();
  expect(harness.requests).toHaveLength(0);
  expect(harness.stored()).toBe('old');
});

test('foreground shared write succeeds only after external reader verifies exact bytes', () => {
  const harness = sharedCredentialHarness();
  withKeychainInteraction(() => harness.keychain.write('Claude Code-credentials', 'test', 'new'));
  expect(harness.stored()).toBe('new');
  const reader = harness.requests.find(request => request.executable === '/usr/bin/security');
  expect(reader?.timeoutMs).toBe(120_000);
  expect(reader?.args).not.toContain('new');
});

test('failed external reader never reports a successful switch even after native readback', () => {
  const harness = sharedCredentialHarness(1);
  expect(() => withKeychainInteraction(() => harness.keychain.write('Claude Code-credentials', 'test', 'new'))).toThrow();
  expect(harness.stored()).toBe('old');
});

test('writing identical credentials never resets their access permissions', () => {
  const harness = sharedCredentialHarness();
  harness.keychain.write('llmtally', 'test', 'old');
  expect(harness.requests.every(request => request.args.includes('--read'))).toBe(true);
});

test('approval denial during rollback remains marked as requiring interaction', () => {
  let stored = 'old';
  let writes = 0;
  const keychain = createMacosKeychain({
    helperPath: '/test/helper',
    runner(request) {
      if (request.args.includes('--read')) {
        return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, phase: 'read', status: 0, value: stored }) };
      }
      writes += 1;
      if (writes === 1) {
        stored = 'new';
        return { exitCode: null, stdout: '' };
      }
      return { exitCode: 1, stdout: JSON.stringify({ version: 1, ok: false, phase: 'update', status: -25308 }) };
    },
  });
  let failure: unknown;
  try { keychain.write('llmtally', 'test', 'new'); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ recovery: 'unknown', requiresInteraction: true });
  expect(stored).toBe('new');
});
