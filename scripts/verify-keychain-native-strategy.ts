import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
};

type BasicResponse = {
  readonly version: 1;
  readonly ok: boolean;
  readonly phase: string;
  readonly status: number | null;
};

type ValueResponse = BasicResponse & { readonly value: string | null };

const repoRoot = resolve(import.meta.dir, '..');
const sourceRoot = join(repoRoot, 'packages', 'core', 'native', 'Sources', 'LLMTallyKeychain');
const helper = join(repoRoot, 'packages', 'core', 'native', 'bin', 'darwin-universal', 'llmtally-keychain');
const workDir = mkdtempSync(join(tmpdir(), 'llmtally-keychain-strategy-'));
const testHelper = join(workDir, 'test-helper');
const keychainPath = join(
  homedir(),
  'Library',
  'Keychains',
  `.llmtally-keychain-strategy-${randomUUID()}.keychain`,
);
const migratedPath = `${keychainPath}-db`;
const password = 'llmtally-synthetic-test-password';
const appleToolPartitionHex = '6170706c652d746f6f6c3a';

function fail(message: string): never {
  throw new Error(`verify-keychain-native-strategy: ${message}`);
}

function execute(argv: readonly string[], input?: string, timeout = 5_000): ProcessResult {
  const startedAt = performance.now();
  const result = Bun.spawnSync([...argv], {
    cwd: repoRoot,
    stdin: input === undefined ? undefined : new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    durationMs: performance.now() - startedAt,
  };
}

function codeDirectoryHash(path: string): string {
  const result = execute(['/usr/bin/codesign', '-dvvv', path]);
  const match = /^CDHash=([0-9a-f]+)$/m.exec(result.stderr);
  if (result.exitCode !== 0 || match?.[1] === undefined) {
    fail(`could not read CDHash for ${path}`);
  }
  return match[1];
}

function addWithSecurity(
  service: string,
  account: string,
  secret: string,
  trustedApplication?: string,
): void {
  const trust = trustedApplication === undefined ? '' : ` -T ${trustedApplication}`;
  const command = `add-generic-password -a ${account} -s ${service}${trust} -w ${secret} ${keychainPath}\n`;
  const result = execute(['/usr/bin/security', '-i'], command);
  if (result.exitCode !== 0) {
    fail(`security-created fixture failed with exit ${result.exitCode}`);
  }
}

type Inspection = {
  readonly ok: boolean;
  readonly status: number;
  readonly decryptTrustAll: boolean;
  readonly decryptTrustedApplicationCount: number;
  readonly partitionDescriptions: readonly string[];
};

function inspect(service: string, account: string): Inspection {
  const text = requireSuccess(
    'inspect security-created item',
    execute([testHelper, '--test-inspect-item', keychainPath, service, account]),
  );
  const decoded: unknown = JSON.parse(text);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('ok' in decoded) ||
    decoded.ok !== true ||
    !('status' in decoded) ||
    decoded.status !== 0 ||
    !('decryptTrustAll' in decoded) ||
    typeof decoded.decryptTrustAll !== 'boolean' ||
    !('decryptTrustedApplicationCount' in decoded) ||
    typeof decoded.decryptTrustedApplicationCount !== 'number' ||
    !('partitionDescriptions' in decoded) ||
    !Array.isArray(decoded.partitionDescriptions) ||
    !decoded.partitionDescriptions.every((value) => typeof value === 'string')
  ) {
    fail('security-created item inspection was invalid');
  }
  return {
    ok: true,
    status: 0,
    decryptTrustAll: decoded.decryptTrustAll,
    decryptTrustedApplicationCount: decoded.decryptTrustedApplicationCount,
    partitionDescriptions: decoded.partitionDescriptions,
  };
}

function requireSuccess(label: string, result: ProcessResult): string {
  if (result.exitCode !== 0) {
    fail(`${label} exited ${result.exitCode}`);
  }
  return result.stdout.trim();
}

function parseResponse(result: ProcessResult, valueResponse: boolean): BasicResponse | ValueResponse {
  if (result.stderr.length !== 0) {
    fail('helper wrote to stderr');
  }
  const lines = result.stdout.trimEnd().split('\n');
  if (lines.length !== 1 || lines[0] === undefined) {
    fail('helper did not emit exactly one response line');
  }
  const decoded: unknown = JSON.parse(lines[0]);
  if (typeof decoded !== 'object' || decoded === null) {
    fail('helper response was not an object');
  }
  const keys = Object.keys(decoded).sort().join(',');
  const expectedKeys = valueResponse ? 'ok,phase,status,value,version' : 'ok,phase,status,version';
  if (
    keys !== expectedKeys ||
    !('version' in decoded) ||
    decoded.version !== 1 ||
    !('ok' in decoded) ||
    typeof decoded.ok !== 'boolean' ||
    !('phase' in decoded) ||
    typeof decoded.phase !== 'string' ||
    !('status' in decoded) ||
    (decoded.status !== null && typeof decoded.status !== 'number')
  ) {
    fail('helper response contract was invalid');
  }
  const basic: BasicResponse = {
    version: 1,
    ok: decoded.ok,
    phase: decoded.phase,
    status: decoded.status,
  };
  if (!valueResponse) {
    return basic;
  }
  if (!('value' in decoded) || (decoded.value !== null && typeof decoded.value !== 'string')) {
    fail('helper value response was invalid');
  }
  return { ...basic, value: decoded.value };
}

function invoke(
  operation: 'write' | 'read' | 'remove' | 'find-account',
  service: string,
  account: string,
  secret?: string,
): { readonly process: ProcessResult; readonly response: BasicResponse | ValueResponse } {
  const args = operation === 'write' ? ['--keychain', keychainPath] : [`--${operation}`, '--keychain', keychainPath];
  const input = JSON.stringify({ version: 1, service, account, ...(secret === undefined ? {} : { secret }) });
  const process = execute([helper, ...args], input);
  return { process, response: parseResponse(process, operation === 'read' || operation === 'find-account') };
}

function stateFingerprint(): string {
  const state = [
    requireSuccess('list-keychains', execute(['/usr/bin/security', 'list-keychains', '-d', 'user'])),
    requireSuccess('default-keychain', execute(['/usr/bin/security', 'default-keychain', '-d', 'user'])),
    requireSuccess('login-keychain', execute(['/usr/bin/security', 'login-keychain'])),
  ];
  return new Bun.CryptoHasher('sha256').update(state.join('\0')).digest('hex');
}

function assertRead(service: string, account: string, expected: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { process, response } = invoke('read', service, account);
    if (
      process.exitCode !== 0 ||
      !response.ok ||
      response.phase !== 'read' ||
      response.status !== 0 ||
      !('value' in response) ||
      response.value !== expected
    ) {
      const valueLength = 'value' in response && response.value !== null ? response.value.length : null;
      fail(
        `native read attempt ${attempt + 1} failed (exit ${process.exitCode}, phase ${response.phase}, status ${response.status}, value length ${valueLength})`,
      );
    }
  }
}

if (process.platform !== 'darwin') {
  rmSync(workDir, { recursive: true, force: true });
  fail('macOS is required');
}

const originalState = stateFingerprint();
let created = false;
try {
  requireSuccess('build helper', execute(['bun', 'scripts/build-keychain-helper.ts'], undefined, 60_000));
  const firstRebuild = join(workDir, 'rebuild-a', 'llmtally-keychain');
  const secondRebuild = join(workDir, 'rebuild-b', 'llmtally-keychain');
  requireSuccess(
    'first reproducibility build',
    execute(['bun', 'scripts/build-keychain-helper.ts', '--output', firstRebuild], undefined, 60_000),
  );
  requireSuccess(
    'second reproducibility build',
    execute(['bun', 'scripts/build-keychain-helper.ts', '--output', secondRebuild], undefined, 60_000),
  );
  const productionHash = codeDirectoryHash(helper);
  if (codeDirectoryHash(firstRebuild) !== productionHash || codeDirectoryHash(secondRebuild) !== productionHash) {
    fail('identical source builds produced different CDHashes');
  }
  requireSuccess(
    'compile test helper',
    execute([
      'xcrun',
      'swiftc',
      '-D',
      'LLMTALLY_KEYCHAIN_TESTING',
      '-framework',
      'Foundation',
      '-framework',
      'LocalAuthentication',
      '-framework',
      'Security',
      join(sourceRoot, 'main.swift'),
      join(sourceRoot, 'TestSupport.swift'),
      '-o',
      testHelper,
    ]),
  );
  requireSuccess('create keychain', execute([testHelper, '--test-create-keychain', keychainPath], password));
  created = true;
  if (!existsSync(migratedPath) || stateFingerprint() !== originalState) {
    fail('modern fixture creation changed global Keychain state');
  }

  const service = 'llmtally-native-strategy';
  const account = 'synthetic-native-account';
  const value9492 = 'A'.repeat(9_492);
  const firstWrite = invoke('write', service, account, value9492);
  if (firstWrite.process.exitCode !== 0 || !firstWrite.response.ok || firstWrite.response.phase !== 'add') {
    fail('native add failed');
  }
  assertRead(service, account, value9492);

  const value64KiB = 'B'.repeat(65_536);
  const secondWrite = invoke('write', service, account, value64KiB);
  if (secondWrite.process.exitCode !== 0 || !secondWrite.response.ok || secondWrite.response.phase !== 'update') {
    fail('native update failed');
  }
  assertRead(service, account, value64KiB);

  const found = invoke('find-account', service, '');
  if (
    found.process.exitCode !== 0 ||
    !found.response.ok ||
    found.response.phase !== 'find-account' ||
    !('value' in found.response) ||
    found.response.value !== account
  ) {
    fail('find-account did not return the unique account');
  }

  const denialCases = [
    { service: 'llmtally-security-only', account: 'synthetic-security-account' },
    {
      service: 'llmtally-partition-mismatch',
      account: 'synthetic-partition-account',
      trustedApplication: helper,
    },
  ] as const;
  const denialStatuses: number[] = [];
  const denialDurations: number[] = [];
  for (const denialCase of denialCases) {
    const trustedApplication = 'trustedApplication' in denialCase ? denialCase.trustedApplication : undefined;
    addWithSecurity(denialCase.service, denialCase.account, 'synthetic-denial-value', trustedApplication);
    const metadata = inspect(denialCase.service, denialCase.account);
    if (
      metadata.decryptTrustAll ||
      metadata.decryptTrustedApplicationCount !== 1 ||
      !metadata.partitionDescriptions.some(
        (description) => description.includes('apple-tool:') || description.includes(appleToolPartitionHex),
      )
    ) {
      fail(
        `security-created ACL metadata mismatch for ${denialCase.service} (trustAll ${metadata.decryptTrustAll}, trusted ${metadata.decryptTrustedApplicationCount}, partitions ${JSON.stringify(metadata.partitionDescriptions)})`,
      );
    }
    const denied = invoke('read', denialCase.service, denialCase.account);
    if (
      denied.process.exitCode !== 1 ||
      denied.process.durationMs >= 2_000 ||
      denied.response.ok ||
      denied.response.phase !== 'read' ||
      ![-25_308, -25_293, -128].includes(denied.response.status ?? 0) ||
      !('value' in denied.response) ||
      denied.response.value !== null
    ) {
      const deniedValueLength =
        'value' in denied.response && denied.response.value !== null ? denied.response.value.length : null;
      fail(
        `security denial mismatch (exit ${denied.process.exitCode}, phase ${denied.response.phase}, status ${denied.response.status}, duration ${denied.process.durationMs.toFixed(0)}ms, value length ${deniedValueLength})`,
      );
    }
    denialStatuses.push(denied.response.status ?? 0);
    denialDurations.push(Math.round(denied.process.durationMs));
  }

  const duplicateAccount = 'synthetic-native-account-duplicate';
  const duplicateWrite = invoke('write', service, duplicateAccount, 'synthetic-duplicate-value');
  if (duplicateWrite.process.exitCode !== 0 || !duplicateWrite.response.ok) {
    fail('duplicate fixture add failed');
  }
  const duplicateFind = invoke('find-account', service, '');
  if (
    duplicateFind.process.exitCode !== 1 ||
    duplicateFind.response.ok ||
    duplicateFind.response.status !== -25_299 ||
    !('value' in duplicateFind.response) ||
    duplicateFind.response.value !== null
  ) {
    fail('find-account did not fail closed for duplicate accounts');
  }

  const invalidAllowUi = execute(
    [helper, '--remove', '--allow-ui', '--keychain', keychainPath],
    JSON.stringify({ version: 1, service, account }),
  );
  const invalidAllowUiResponse = parseResponse(invalidAllowUi, false);
  if (invalidAllowUi.exitCode !== 2 || invalidAllowUiResponse.phase !== 'protocol') {
    fail('--allow-ui was accepted for a non-read operation');
  }

  const removed = invoke('remove', service, account);
  const duplicateRemoved = invoke('remove', service, duplicateAccount);
  const removedAgain = invoke('remove', service, account);
  if (
    removed.process.exitCode !== 0 ||
    !removed.response.ok ||
    duplicateRemoved.process.exitCode !== 0 ||
    removedAgain.process.exitCode !== 0
  ) {
    fail('remove was not successful and idempotent');
  }
  const absent = invoke('read', service, account);
  if (
    absent.process.exitCode !== 1 ||
    absent.response.ok ||
    absent.response.status !== -25_300 ||
    !('value' in absent.response) ||
    absent.response.value !== null
  ) {
    fail('absent read response was invalid');
  }

  console.log(
    `verify-keychain-native-strategy: PASS — native add/update/read 9492/65536 repeated; duplicate fail-closed; no-UI denials ${denialStatuses.join('/')} in ${denialDurations.join('/')}ms; deterministic CDHash ${productionHash}; remove/absence; state ${originalState}`,
  );
} finally {
  if (created) {
    const deletion = execute([testHelper, '--test-delete-keychain', keychainPath]);
    if (deletion.exitCode !== 0 || existsSync(keychainPath) || existsSync(migratedPath)) {
      console.error('verify-keychain-native-strategy: FAIL — temporary Keychain cleanup failed');
      process.exitCode = 1;
    }
  }
  rmSync(workDir, { recursive: true, force: true });
  if (stateFingerprint() !== originalState) {
    console.error('verify-keychain-native-strategy: FAIL — global Keychain state changed');
    process.exitCode = 1;
  }
}
