/**
 * Packaging gate: proves the npm tarball actually works after install,
 * in a throwaway global prefix that never touches the machine's real
 * one. This is the CI twin of `install:local` — the failure class it
 * guards is "resolves in the checkout, dies after publishing" (missing
 * files entry, broken path map, launcher pointing at nothing).
 *
 *   1. `bun pm pack` into a temp directory
 *   2. `bun install -g <tgz>` with BUN_INSTALL pointed at the temp dir
 *   3. run the installed bin with --help (exercises the node launcher
 *      handing over to Bun and the tsconfig path map)
 *   4. run the installed scan-worker headless against a temp ledger
 *      (exercises the file the launchd plist points at)
 *
 * Usage: bun scripts/verify-pack-install.ts
 * Exit codes: 0 pass, 1 fail.
 */
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const workDir = mkdtempSync(join(tmpdir(), 'llmtally-pack-gate-'));
const helperRelativePath = join('packages', 'core', 'native', 'bin', 'darwin-universal', 'llmtally-keychain');

function fail(message: string): never {
  console.error(`verify-pack-install: FAIL — ${message}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

function run(
  label: string,
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  cwd = repoRoot,
): string {
  const result = Bun.spawnSync([...argv], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  if (result.exitCode !== 0) {
    fail(`${label} exited ${result.exitCode}\n${result.stderr.toString()}\n${result.stdout.toString()}`);
  }
  return result.stdout.toString();
}

function requireExecutable(label: string, path: string): void {
  if (!existsSync(path)) {
    fail(`${label} is missing at ${path}`);
  }
  if ((statSync(path).mode & 0o111) === 0) {
    fail(`${label} is not executable at ${path}`);
  }
}

function requireLaunchFailure(label: string, path: string, expectedCode: 'EACCES' | 'ENOENT'): void {
  try {
    const result = Bun.spawnSync([path, '--version'], { cwd: workDir, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      return;
    }
    fail(`${label} unexpectedly executed`);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === expectedCode) {
      return;
    }
    fail(`${label} failed with an unexpected launch error`);
  }
}

function helperVersion(label: string, path: string, env: Record<string, string | undefined>): string {
  const text = run(`${label} --version`, [path, '--version'], env, workDir).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${label} --version did not emit JSON`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Reflect.get(parsed, 'version') !== 1 ||
    typeof Reflect.get(parsed, 'sourceDigest') !== 'string'
  ) {
    fail(`${label} --version did not report protocol v1 and a source digest`);
  }
  return text;
}

run('build keychain helper', ['bun', 'run', 'build:keychain-helper']);
run('check keychain helper', ['bun', 'run', 'verify:keychain-helper']);
const checkoutHelper = join(repoRoot, helperRelativePath);
requireExecutable('checkout keychain helper', checkoutHelper);
const compilerlessPath = dirname(process.execPath);
const compilerlessEnvironment = { PATH: compilerlessPath };
const checkoutHelperVersion = helperVersion('checkout keychain helper', checkoutHelper, compilerlessEnvironment);

// 1. pack
run('bun pm pack', ['bun', 'pm', 'pack', '--destination', workDir]);
const tarball = readdirSync(workDir).find((entry) => entry.endsWith('.tgz'));
if (tarball === undefined) {
  fail('bun pm pack produced no tarball');
}

// 2. install into a throwaway global prefix
const globalDir = join(workDir, 'global');
run('bun install -g', ['bun', 'install', '--global', join(workDir, tarball)], {
  BUN_INSTALL: globalDir,
});

// 3. the installed bin must launch and resolve its imports
const bin = join(globalDir, 'bin', 'llmtally');
const help = run('installed llmtally --help', [bin, '--help']);
if (!help.includes('llmtally')) {
  fail(`--help output looks wrong:\n${help}`);
}

// 4. the daemon worker must ship next to the entry point and run headless
const installedPackage = join(globalDir, 'install', 'global', 'node_modules', 'llmtally');
const installedHelper = join(installedPackage, helperRelativePath);
requireExecutable('installed keychain helper', installedHelper);
const installedHelperVersion = helperVersion('installed keychain helper', installedHelper, compilerlessEnvironment);
if (installedHelperVersion !== checkoutHelperVersion) {
  fail('installed keychain helper does not match the checked source artifact');
}
run('installed package keychain switch', [
  'bun',
  'scripts/verify-keychain-switch.ts',
  '--package-root',
  installedPackage,
]);

const missingHelper = join(workDir, 'missing-llmtally-keychain');
if (existsSync(missingHelper)) {
  fail('missing-helper probe unexpectedly exists');
}
requireLaunchFailure('missing helper', missingHelper, 'ENOENT');
const nonExecutableHelper = join(workDir, 'non-executable-llmtally-keychain');
copyFileSync(installedHelper, nonExecutableHelper);
chmodSync(nonExecutableHelper, 0o644);
if ((statSync(nonExecutableHelper).mode & 0o111) !== 0) {
  fail('non-executable helper probe retained an execute bit');
}
requireLaunchFailure('non-executable helper', nonExecutableHelper, 'EACCES');

const worker = join(installedPackage, 'packages', 'tui', 'src', 'scan-worker.ts');
const ledger = join(workDir, 'ledger.db');
const summary = run('installed scan-worker', ['bun', worker, '--db', ledger]);
if (!summary.includes('scanned')) {
  fail(`scan-worker output looks wrong:\n${summary}`);
}

console.log(`verify-pack-install: PASS — ${tarball} installs, launches, scans headless, and includes an executable keychain helper`);
rmSync(workDir, { recursive: true, force: true });
