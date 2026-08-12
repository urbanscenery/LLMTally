#!/usr/bin/env node
/**
 * Thin launcher so an npm install without Bun fails with an actionable
 * message instead of `env: bun: No such file or directory`. llmtally
 * itself runs on Bun only (bun:sqlite, Bun.spawnSync); this wrapper
 * just finds the runtime and hands over.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const main = join(__dirname, '..', 'packages', 'tui', 'src', 'main.ts');
const result = spawnSync('bun', [main, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error && result.error.code === 'ENOENT') {
  console.error('llmtally needs the Bun runtime (https://bun.sh) — install it and run again:');
  console.error('  curl -fsSL https://bun.sh/install | bash');
  process.exit(1);
}
if (result.signal !== null) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status === null ? 1 : result.status);
