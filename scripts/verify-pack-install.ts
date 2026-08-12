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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const workDir = mkdtempSync(join(tmpdir(), 'llmtally-pack-gate-'));

function fail(message: string): never {
  console.error(`verify-pack-install: FAIL — ${message}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

function run(
  label: string,
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): string {
  const result = Bun.spawnSync([...argv], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  if (result.exitCode !== 0) {
    fail(`${label} exited ${result.exitCode}\n${result.stderr.toString()}\n${result.stdout.toString()}`);
  }
  return result.stdout.toString();
}

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
const worker = join(installedPackage, 'packages', 'tui', 'src', 'scan-worker.ts');
const ledger = join(workDir, 'ledger.db');
const summary = run('installed scan-worker', ['bun', worker, '--db', ledger]);
if (!summary.includes('scanned')) {
  fail(`scan-worker output looks wrong:\n${summary}`);
}

console.log(`verify-pack-install: PASS — ${tarball} installs, launches, and scans headless`);
rmSync(workDir, { recursive: true, force: true });
