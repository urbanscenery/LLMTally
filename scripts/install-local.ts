/**
 * Packs the working tree and installs it globally the way a user would.
 *
 * The global `llmtally` on this machine is a real tarball install rather
 * than a `bun link` symlink, which is what exercises the packaged layout
 * — a missing file in `package.json#files` shows up here and nowhere in
 * development. The tarball lives at a stable path because bun records
 * the path it installed from: pointing that at a temp directory leaves
 * the global manifest referring to something that no longer exists.
 *
 * Bun refuses to install over an existing entry that names a different
 * source ("DependencyLoop"), so the old one is removed first.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIST_DIR = join(homedir(), '.llmtally', 'dist');

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited ${result.exitCode}`);
  }
}

const root = join(import.meta.dir, '..');
// a stale tarball of another version would make the pick below ambiguous
rmSync(DIST_DIR, { recursive: true, force: true });
mkdirSync(DIST_DIR, { recursive: true });

Bun.spawnSync(['bun', 'pm', 'pack', '--destination', DIST_DIR], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});

const tarball = readdirSync(DIST_DIR).find((name) => name.endsWith('.tgz'));
if (tarball === undefined) {
  throw new Error(`no tarball was produced in ${DIST_DIR}`);
}
const packed = join(DIST_DIR, tarball);

// removing first is not optional: bun treats re-installing from a
// different source path as a dependency loop and aborts
Bun.spawnSync(['bun', 'remove', '-g', 'llmtally'], { stdout: 'ignore', stderr: 'ignore' });
run(['bun', 'install', '-g', packed]);

// resolution of the packaged layout is the thing that actually broke
// before, so prove it rather than assuming the install implies it
run([join(homedir(), '.bun', 'bin', 'llmtally'), '--help']);
console.log(`\ninstalled ${tarball} from ${DIST_DIR}`);
