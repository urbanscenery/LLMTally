import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createMacosKeychain,
  withKeychainInteraction,
} from '../packages/core/src/accounts/keychain.ts';
import { runKeychainSwitchQa } from './keychain-switch-qa-fixture.ts';

const repoRoot = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);

function option(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a path`);
  }
  return resolve(value);
}

if (process.platform !== 'darwin') {
  throw new Error('verify-keychain-switch requires macOS');
}

const packageRoot = option('--package-root');
const appBundle = option('--app-bundle');
if (packageRoot !== null && appBundle !== null) {
  throw new Error('use only one of --package-root or --app-bundle');
}

const artifact = packageRoot !== null ? 'package' : appBundle !== null ? 'app' : 'source';
const helperPath =
  appBundle !== null
    ? join(appBundle, 'Contents', 'Helpers', 'llmtally-keychain')
    : join(packageRoot ?? repoRoot, 'packages', 'core', 'native', 'bin', 'darwin-universal', 'llmtally-keychain');
if (!existsSync(helperPath)) {
  throw new Error(`keychain helper is missing: ${helperPath}`);
}

const sourceRoot = join(
  packageRoot ?? repoRoot,
  'packages', 'core', 'native', 'Sources', 'LLMTallyKeychain',
);
if (packageRoot !== null && packageRoot !== repoRoot) {
  const adapterUrl = pathToFileURL(join(packageRoot, 'packages', 'core', 'src', 'accounts', 'keychain.ts')).href;
  const fixtureUrl = pathToFileURL(join(repoRoot, 'scripts', 'keychain-switch-qa-fixture.ts')).href;
  const source = [
    `import { createMacosKeychain, withKeychainInteraction } from ${JSON.stringify(adapterUrl)};`,
    `import { runKeychainSwitchQa } from ${JSON.stringify(fixtureUrl)};`,
    `await runKeychainSwitchQa({ createMacosKeychain, withKeychainInteraction, helperPath: ${JSON.stringify(helperPath)}, sourceRoot: ${JSON.stringify(sourceRoot)}, artifact: 'package' });`,
  ].join('\n');
  const child = Bun.spawnSync(['bun', '-e', source], { stdout: 'inherit', stderr: 'inherit', timeout: 120_000 });
  if (child.exitCode !== 0) {
    throw new Error(`package-root switch QA failed with exit ${child.exitCode}`);
  }
} else {
  await runKeychainSwitchQa({
    createMacosKeychain,
    withKeychainInteraction,
    helperPath,
    sourceRoot,
    artifact,
  });
}
