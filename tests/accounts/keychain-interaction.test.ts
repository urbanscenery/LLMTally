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

// Items owned by another CLI (Claude Code, Cursor) are written by
// /usr/bin/security, so their partition list names only `apple-tool:`
// and every token refresh resets it to that. The ad-hoc helper's
// cdhash partition never survives, so those reads go through the one
// reader the item always trusts (observed 2026-09-18: helper -25293
// right after Claude Code's SecKeychainItemModifyContent).
function externalReadHarness(result: { exitCode: number | null; stderr?: string }, keychainPath?: string) {
  const requests: KeychainProcessRequest[] = [];
  const keychain = createMacosKeychain({
    helperPath: '/test/helper',
    ...(keychainPath === undefined ? {} : { keychainPath }),
    runner(request) {
      requests.push(request);
      return { exitCode: result.exitCode, stdout: '', stderr: result.stderr ?? '' };
    },
  });
  return { keychain, requests };
}

test('externally owned items are read through /usr/bin/security, never the helper', () => {
  const harness = externalReadHarness({ exitCode: 0, stderr: 'password: "opaque-token"\n' });
  expect(harness.keychain.read('Claude Code-credentials', 'someone')).toEqual({ kind: 'found', value: 'opaque-token' });
  expect(harness.requests).toHaveLength(1);
  expect(harness.requests[0]?.executable).toBe('/usr/bin/security');
  expect(harness.requests[0]?.args).toEqual(['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'someone', '-g']);
  expect(harness.requests[0]?.timeoutMs).toBe(5000);
});

test('an explicit keychain path is passed to the external reader', () => {
  const harness = externalReadHarness({ exitCode: 0, stderr: 'password: "v"\n' }, '/tmp/test.keychain-db');
  harness.keychain.read('cursor-access-token', 'cursor-user');
  expect(harness.requests[0]?.args.at(-1)).toBe('/tmp/test.keychain-db');
});

test('a missing external item is absent, not an error', () => {
  const harness = externalReadHarness({ exitCode: 44 });
  expect(harness.keychain.read('cursor-access-token', 'cursor-user')).toEqual({ kind: 'absent' });
});

test('an external read refused for approval asks for authorization without leaking output', () => {
  for (const exitCode of [36, 51, 128, null]) {
    const harness = externalReadHarness({ exitCode, stderr: 'password: "SECRET-MUST-NOT-LEAK"\n' });
    const result = harness.keychain.read('Claude Code-credentials', 'someone');
    expect(result).toMatchObject({ kind: 'error', requiresInteraction: true });
    expect(JSON.stringify(result)).not.toContain('SECRET-MUST-NOT-LEAK');
  }
});

test('an unexpected external failure is an error that does not claim to need approval', () => {
  const harness = externalReadHarness({ exitCode: 1 });
  const result = harness.keychain.read('Claude Code-credentials', 'someone');
  expect(result.kind).toBe('error');
  expect(result).not.toMatchObject({ requiresInteraction: true });
});

test('an explicit authorization gives the external reader time to show its dialog', () => {
  const harness = externalReadHarness({ exitCode: 0, stderr: 'password: "v"\n' });
  withKeychainInteraction(() => harness.keychain.read('Claude Code-credentials', 'someone'));
  expect(harness.requests[0]?.timeoutMs).toBe(120_000);
});
