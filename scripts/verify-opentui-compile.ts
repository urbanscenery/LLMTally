/**
 * P0 packaging spike: compiles the opentui smoke fixture with
 * `bun build --compile`, copies the binary to an empty temp directory
 * (no repo, no node_modules), runs it inside a PTY via `script -q`,
 * sends "q", and verifies the frame and a clean exit.
 *
 * Usage: bun scripts/verify-opentui-compile.ts
 * Exit codes: 0 pass, 1 fail.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const workDir = mkdtempSync(join(tmpdir(), 'llmtally-opentui-spike-'));
const binaryPath = join(workDir, 'opentui-smoke');

/**
 * bun 1.3.x leaks its ~60MB `.{hash}-{n}.bun-build` compile temp in the
 * build's cwd even on success; two compiles per run added up to
 * gigabytes at the repo root before this cleanup existed.
 */
function removeLeakedBunBuildTemps(): void {
  for (const name of readdirSync(repoRoot)) {
    if (/^\.[0-9a-f]{16}-[0-9a-f]{8}\.bun-build$/.test(name)) {
      rmSync(join(repoRoot, name), { force: true });
    }
  }
}

function fail(message: string): never {
  console.error(`verify-opentui-compile: FAIL — ${message}`);
  rmSync(workDir, { recursive: true, force: true });
  removeLeakedBunBuildTemps();
  process.exit(1);
}

const build = Bun.spawnSync(
  [
    'bun',
    'build',
    '--compile',
    'tests/tui/fixtures/opentui-compile-smoke.ts',
    '--outfile',
    binaryPath,
  ],
  { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
);
if (build.exitCode !== 0) {
  fail(`bun build --compile exited ${build.exitCode}\n${build.stderr.toString()}`);
}

// `script -q` allocates a PTY so the binary sees a real terminal; stdin
// is forwarded, so a delayed "q" exercises raw-mode input and teardown.
const run = Bun.spawnSync(
  ['sh', '-c', `{ sleep 3; printf q; sleep 2; } | script -q /dev/null "${binaryPath}"`],
  {
    cwd: workDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TERM: 'xterm-256color' },
  },
);

const frame = run.stdout.toString();
const stderrText = run.stderr.toString();

if (run.exitCode !== 0) {
  fail(`binary exited ${run.exitCode}\nstderr: ${stderrText.slice(0, 2000)}`);
}
if (!frame.includes('OPENTUI_SMOKE_OK')) {
  fail(`frame does not contain OPENTUI_SMOKE_OK\nstdout: ${frame.slice(0, 2000)}`);
}
if (/Failed to initialize OpenTUI render library/i.test(frame + stderrText)) {
  fail('native render library failed to initialize');
}

// the real entrypoint must also compile and dispatch from an empty dir
const appBinary = join(workDir, 'llmtally');
const appBuild = Bun.spawnSync(
  ['bun', 'build', '--compile', 'packages/tui/src/main.ts', '--outfile', appBinary],
  { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
);
if (appBuild.exitCode !== 0) {
  fail(`entrypoint compile exited ${appBuild.exitCode}\n${appBuild.stderr.toString()}`);
}
const help = Bun.spawnSync([appBinary, '--help'], { cwd: workDir, stdout: 'pipe', stderr: 'pipe' });
if (help.exitCode !== 0 || !help.stdout.toString().includes('Tabs:')) {
  fail(`compiled llmtally --help failed (exit ${help.exitCode})`);
}

rmSync(workDir, { recursive: true, force: true });
removeLeakedBunBuildTemps();
console.log('verify-opentui-compile: PASS — compiled binaries rendered and exited cleanly');
