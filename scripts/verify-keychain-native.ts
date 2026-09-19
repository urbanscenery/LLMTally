import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type HelperResponse = {
  readonly version: number;
  readonly ok: boolean;
  readonly phase: string;
  readonly status: number | null;
};

type Inspection = {
  readonly ok: boolean;
  readonly status: number;
  readonly decryptAclCount: number;
  readonly decryptTrustAll: boolean;
  readonly decryptTrustedApplicationCount: number;
  readonly attributesMatch: boolean;
  readonly decryptPromptSelectors: readonly number[];
  readonly decryptTrustedApplicationFingerprints: readonly string[];
  readonly nonIntegrityAuthorizationSets: readonly (readonly string[])[];
  readonly partitionDescriptions: readonly string[];
};

const repoRoot = resolve(import.meta.dir, '..');
const productionHelper = join(
  repoRoot,
  'packages',
  'core',
  'native',
  'bin',
  'darwin-universal',
  'llmtally-keychain',
);
const sourceRoot = join(repoRoot, 'packages', 'core', 'native', 'Sources', 'LLMTallyKeychain');
const workDir = mkdtempSync(join(tmpdir(), 'llmtally-keychain-native-'));
const testHelper = join(workDir, 'llmtally-keychain-test-support');
const keychainPath = join(
  homedir(),
  'Library',
  'Keychains',
  `.llmtally-keychain-native-${randomUUID()}.keychain`,
);
const migratedKeychainPath = `${keychainPath}-db`;
const password = 'llmtally-synthetic-test-password';
const phaseArguments = process.argv.slice(2);

function fail(message: string): never {
  throw new Error(`verify-keychain-native: ${message}`);
}

function execute(argv: readonly string[], input?: string, timeout = 10_000): ProcessResult {
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
  };
}

function requireSuccess(label: string, result: ProcessResult): string {
  if (result.exitCode !== 0) {
    fail(`${label} exited ${result.exitCode}`);
  }
  return result.stdout.trim();
}

function parseHelperResponse(result: ProcessResult, expectedExit: number): HelperResponse {
  if (result.exitCode !== expectedExit || result.stderr.length !== 0) {
    fail(`helper exit/stream contract mismatch (exit ${result.exitCode})`);
  }
  const lines = result.stdout.trimEnd().split('\n');
  if (lines.length !== 1) {
    fail('helper did not emit exactly one stdout line');
  }
  const line = lines[0];
  if (line === undefined) {
    fail('helper emitted no response');
  }
  const decoded: unknown = JSON.parse(line);
  if (typeof decoded !== 'object' || decoded === null) {
    fail('helper response is not an object');
  }
  const keys = Object.keys(decoded).sort().join(',');
  if (keys !== 'ok,phase,status,version') {
    fail(`helper response fields are invalid: ${keys}`);
  }
  if (
    !('version' in decoded) ||
    decoded.version !== 1 ||
    !('ok' in decoded) ||
    typeof decoded.ok !== 'boolean' ||
    !('phase' in decoded) ||
    typeof decoded.phase !== 'string' ||
    !('status' in decoded) ||
    (decoded.status !== null && typeof decoded.status !== 'number')
  ) {
    fail('helper response value types are invalid');
  }
  return {
    version: decoded.version,
    ok: decoded.ok,
    phase: decoded.phase,
    status: decoded.status,
  };
}

function writeWithProductionHelper(
  service: string,
  account: string,
  secret: string,
  architecture: 'native' | 'x86_64' = 'native',
): HelperResponse {
  const request = JSON.stringify({ version: 1, service, account, secret });
  const command =
    architecture === 'x86_64'
      ? ['/usr/bin/arch', '-x86_64', productionHelper, '--keychain', keychainPath]
      : [productionHelper, '--keychain', keychainPath];
  return parseHelperResponse(execute(command, request), 0);
}

function readWithSecurity(service: string, account: string): string {
  const result = execute([
    '/usr/bin/security',
    'find-generic-password',
    '-w',
    '-s',
    service,
    '-a',
    account,
    keychainPath,
  ]);
  if (result.exitCode !== 0) {
    fail(`security reader failed for ${service}`);
  }
  return result.stdout.replace(/\n$/, '');
}

function inspect(service: string, account: string): Inspection {
  const text = requireSuccess(
    'test ACL inspector',
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
    !('decryptAclCount' in decoded) ||
    typeof decoded.decryptAclCount !== 'number' ||
    !('decryptTrustAll' in decoded) ||
    typeof decoded.decryptTrustAll !== 'boolean' ||
    !('decryptTrustedApplicationCount' in decoded) ||
    typeof decoded.decryptTrustedApplicationCount !== 'number' ||
    !('attributesMatch' in decoded) ||
    typeof decoded.attributesMatch !== 'boolean' ||
    !('decryptPromptSelectors' in decoded) ||
    !Array.isArray(decoded.decryptPromptSelectors) ||
    !decoded.decryptPromptSelectors.every((value) => typeof value === 'number') ||
    !('decryptTrustedApplicationFingerprints' in decoded) ||
    !Array.isArray(decoded.decryptTrustedApplicationFingerprints) ||
    !decoded.decryptTrustedApplicationFingerprints.every((value) => typeof value === 'string') ||
    !('nonIntegrityAuthorizationSets' in decoded) ||
    !Array.isArray(decoded.nonIntegrityAuthorizationSets) ||
    !decoded.nonIntegrityAuthorizationSets.every(
      (value) => Array.isArray(value) && value.every((authorization) => typeof authorization === 'string'),
    ) ||
    !('partitionDescriptions' in decoded) ||
    !Array.isArray(decoded.partitionDescriptions) ||
    !decoded.partitionDescriptions.every((value) => typeof value === 'string')
  ) {
    fail('test ACL inspector returned an invalid response');
  }
  return {
    ok: decoded.ok,
    status: decoded.status,
    decryptAclCount: decoded.decryptAclCount,
    decryptTrustAll: decoded.decryptTrustAll,
    decryptTrustedApplicationCount: decoded.decryptTrustedApplicationCount,
    attributesMatch: decoded.attributesMatch,
    decryptPromptSelectors: decoded.decryptPromptSelectors,
    decryptTrustedApplicationFingerprints: decoded.decryptTrustedApplicationFingerprints,
    nonIntegrityAuthorizationSets: decoded.nonIntegrityAuthorizationSets,
    partitionDescriptions: decoded.partitionDescriptions,
  };
}

function keychainState(): readonly string[] {
  return [
    requireSuccess('security list-keychains', execute(['/usr/bin/security', 'list-keychains', '-d', 'user'])),
    requireSuccess('security default-keychain', execute(['/usr/bin/security', 'default-keychain', '-d', 'user'])),
    requireSuccess('security login-keychain', execute(['/usr/bin/security', 'login-keychain'])),
  ];
}

function stateFingerprint(state: readonly string[]): string {
  return new Bun.CryptoHasher('sha256').update(state.join('\0')).digest('hex');
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    fail(`${label} equality check failed (actual length ${actual.length}, expected length ${expected.length})`);
  }
}

if (process.platform !== 'darwin') {
  rmSync(workDir, { recursive: true, force: true });
  fail('macOS is required');
}
if (
  phaseArguments.length !== 2 ||
  phaseArguments[0] !== '--phase' ||
  (phaseArguments[1] !== 'compatibility' && phaseArguments[1] !== 'all')
) {
  rmSync(workDir, { recursive: true, force: true });
  fail('usage: bun scripts/verify-keychain-native.ts --phase compatibility');
}

const originalState = keychainState();
let created = false;
try {
  requireSuccess(
    'build production helper',
    execute(['bun', 'scripts/build-keychain-helper.ts'], undefined, 60_000),
  );
  requireSuccess(
    'compile test support',
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
  requireSuccess(
    'create isolated keychain',
    execute([testHelper, '--test-create-keychain', keychainPath], password),
  );
  created = true;
  if (!existsSync(migratedKeychainPath)) {
    fail('isolated keychain did not migrate to the partition-enabled format');
  }
  if (stateFingerprint(keychainState()) !== stateFingerprint(originalState)) {
    fail('SecKeychainCreate changed the user search/default/login keychain state');
  }

  const existingService = 'llmtally-native-existing';
  const existingAccount = 'synthetic-existing-account';
  requireSuccess(
    'security create existing item',
    execute([
      '/usr/bin/security',
      'add-generic-password',
      '-a',
      existingAccount,
      '-s',
      existingService,
      '-w',
      'synthetic-initial-value',
      keychainPath,
    ]),
  );
  const aclBefore = inspect(existingService, existingAccount);
  if (aclBefore.partitionDescriptions.length < 1) {
    fail('isolated keychain did not expose a partition ACL');
  }
  const value9492 = 'A'.repeat(9_492);
  const response9492 = writeWithProductionHelper(existingService, existingAccount, value9492);
  if (!response9492.ok || response9492.phase !== 'update' || response9492.status !== 0) {
    fail('9492-byte existing-item update did not report success');
  }
  const aclAfter9492 = inspect(existingService, existingAccount);
  if (JSON.stringify(aclAfter9492) !== JSON.stringify(aclBefore)) {
    fail('existing item ACL or attributes changed after update');
  }
  assertEqual(readWithSecurity(existingService, existingAccount), value9492, '9492-byte read-back');

  const value64KiB = 'B'.repeat(65_536);
  writeWithProductionHelper(existingService, existingAccount, value64KiB);
  if (JSON.stringify(inspect(existingService, existingAccount)) !== JSON.stringify(aclBefore)) {
    fail('existing item ACL or attributes changed after 64 KiB update');
  }
  assertEqual(readWithSecurity(existingService, existingAccount), value64KiB, '64 KiB existing read-back');

  const newService = 'llmtally-native-created';
  const newAccount = 'synthetic-new-account';
  const newResponse = writeWithProductionHelper(newService, newAccount, value64KiB);
  if (!newResponse.ok || newResponse.phase !== 'add' || newResponse.status !== 0) {
    fail('native-created item did not report success');
  }
  const newInspection = inspect(newService, newAccount);
  if (
    newInspection.decryptAclCount < 1 ||
    newInspection.decryptTrustAll ||
    newInspection.decryptTrustedApplicationCount < 1 ||
    !newInspection.attributesMatch
  ) {
    fail('native-created item ACL or attributes are unsafe');
  }
  if (!newInspection.partitionDescriptions.some((description) => description.includes('6170706c652d746f6f6c3a'))) {
    fail('native-created item partition ACL does not include the security reader');
  }
  assertEqual(readWithSecurity(newService, newAccount), value64KiB, '64 KiB native-created read-back');

  const x86Service = 'llmtally-native-x86-runtime';
  const x86Account = 'synthetic-x86-account';
  const x86Value = 'R'.repeat(9_492);
  const x86Response = writeWithProductionHelper(x86Service, x86Account, x86Value, 'x86_64');
  if (!x86Response.ok || x86Response.phase !== 'add' || x86Response.status !== 0) {
    fail('x86_64 runtime native-created item did not report success');
  }
  assertEqual(readWithSecurity(x86Service, x86Account), x86Value, 'x86_64 runtime read-back');

  const malformed = parseHelperResponse(
    execute([productionHelper, '--keychain', keychainPath], '{'),
    2,
  );
  const wrongVersion = parseHelperResponse(
    execute(
      [productionHelper, '--keychain', keychainPath],
      JSON.stringify({ version: 2, service: 'synthetic', account: 'synthetic', secret: 'synthetic' }),
    ),
    2,
  );
  const oversized = parseHelperResponse(
    execute([productionHelper, '--keychain', keychainPath], 'X'.repeat(1_048_577)),
    2,
  );
  for (const response of [malformed, wrongVersion, oversized]) {
    if (response.ok || response.phase !== 'protocol' || response.status !== null) {
      fail('protocol rejection response is invalid');
    }
  }

  requireSuccess('lock isolated keychain', execute(['/usr/bin/security', 'lock-keychain', keychainPath]));
  const lockedRequest = JSON.stringify({
    version: 1,
    service: existingService,
    account: existingAccount,
    secret: 'synthetic-locked-replacement',
  });
  const locked = parseHelperResponse(
    execute([productionHelper, '--keychain', keychainPath], lockedRequest),
    1,
  );
  if (locked.ok || locked.status === null || locked.status === 0) {
    fail('locked keychain was not reported as a native failure');
  }
  requireSuccess(
    'unlock isolated keychain',
    execute(['/usr/bin/security', 'unlock-keychain', '-p', password, keychainPath]),
  );
  assertEqual(readWithSecurity(existingService, existingAccount), value64KiB, 'locked failure unchanged');

  console.log(
    `verify-keychain-native: PASS — production universal helper; arm64 existing 9492/65536; arm64 native-created 65536; x86_64 Rosetta native-created 9492; ACL preserved/restricted; protocol rejects; locked unchanged; state ${stateFingerprint(originalState)}`,
  );
} finally {
  if (created) {
    const deletion = execute([testHelper, '--test-delete-keychain', keychainPath]);
    if (deletion.exitCode !== 0) {
      console.error(`verify-keychain-native: FAIL — SecKeychainDelete exited ${deletion.exitCode}`);
      process.exitCode = 1;
    } else if (existsSync(keychainPath) || existsSync(migratedKeychainPath)) {
      console.error('verify-keychain-native: FAIL — SecKeychainDelete left the temporary file behind');
      process.exitCode = 1;
    }
  }
  rmSync(workDir, { recursive: true, force: true });
  if (stateFingerprint(keychainState()) !== stateFingerprint(originalState)) {
    console.error('verify-keychain-native: FAIL — user search/default/login keychain state changed');
    process.exitCode = 1;
  }
}
