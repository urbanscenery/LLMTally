import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const nativeRoot = join(repoRoot, 'packages', 'core', 'native');
const sourceRoot = join(nativeRoot, 'Sources', 'LLMTallyKeychain');
const defaultOutput = join(nativeRoot, 'bin', 'darwin-universal', 'llmtally-keychain');
const argumentsAfterScript = process.argv.slice(2);

function fail(message: string): never {
  throw new Error(`build-keychain-helper: FAIL — ${message}`);
}

type BuildOptions = {
  readonly checkOnly: boolean;
  readonly outputPath: string;
};

function optionsFromArguments(): BuildOptions {
  if (argumentsAfterScript.length === 0) {
    return { checkOnly: false, outputPath: defaultOutput };
  }
  if (argumentsAfterScript.length === 2 && argumentsAfterScript[0] === '--output') {
    const candidate = argumentsAfterScript[1];
    if (candidate !== undefined) {
      return { checkOnly: false, outputPath: resolve(candidate) };
    }
  }
  if (argumentsAfterScript.length === 1 && argumentsAfterScript[0] === '--check') {
    return { checkOnly: true, outputPath: defaultOutput };
  }
  return fail('usage: bun scripts/build-keychain-helper.ts [--output <path> | --check]');
}

function run(label: string, argv: readonly string[]): string {
  const result = Bun.spawnSync([...argv], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    fail(`${label} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

const swiftSources = readdirSync(sourceRoot)
  .filter((name) => name.endsWith('.swift'))
  .sort()
  .map((name) => join(sourceRoot, name));
const digest = new Bun.CryptoHasher('sha256');
for (const path of [join(nativeRoot, 'Package.swift'), ...swiftSources]) {
  digest.update(basename(path));
  digest.update(readFileSync(path));
}
const sourceDigest = digest.digest('hex');
const options = optionsFromArguments();
const outputPath = options.outputPath;

function validateBuiltHelper(path: string): string {
  const mode = statSync(path).mode & 0o111;
  if (mode === 0) {
    fail('helper is not executable');
  }
  const versionText = run('--version', [path, '--version']);
  const version: unknown = JSON.parse(versionText);
  if (
    typeof version !== 'object' ||
    version === null ||
    !('version' in version) ||
    version.version !== 1 ||
    !('sourceDigest' in version) ||
    version.sourceDigest !== sourceDigest
  ) {
    fail('built helper reported a mismatched protocol version or source digest');
  }
  const architectures = run('lipo -archs', ['xcrun', 'lipo', '-archs', path]);
  if (!architectures.includes('arm64') || !architectures.includes('x86_64')) {
    fail(`built helper is not universal: ${architectures}`);
  }
  return architectures;
}

if (options.checkOnly) {
  const architectures = validateBuiltHelper(outputPath);
  console.log(`build-keychain-helper: PASS — current protocol v1 ${architectures} digest ${sourceDigest}`);
  process.exit(0);
}

const workDir = mkdtempSync(join(tmpdir(), 'llmtally-keychain-build-'));

try {
  const generatedInfo = join(workDir, 'BuildInfo.swift');
  writeFileSync(generatedInfo, `let llmtallyBuildSourceDigest = "${sourceDigest}"\n`, { mode: 0o600 });
  const slices: string[] = [];
  for (const architecture of ['arm64', 'x86_64'] as const) {
    const slice = join(workDir, `llmtally-keychain-${architecture}`);
    run(`swiftc ${architecture}`, [
      'xcrun',
      'swiftc',
      '-O',
      '-whole-module-optimization',
      '-D',
      'LLMTALLY_BUILD',
      '-target',
      `${architecture}-apple-macos13.0`,
      '-framework',
      'Foundation',
      '-framework',
      'LocalAuthentication',
      '-framework',
      'Security',
      ...swiftSources,
      generatedInfo,
      '-o',
      slice,
    ]);
    slices.push(slice);
  }

  const stagedOutput = join(workDir, 'llmtally-keychain');
  run('lipo', ['xcrun', 'lipo', '-create', ...slices, '-output', stagedOutput]);
  chmodSync(stagedOutput, 0o755);
  run('codesign', ['/usr/bin/codesign', '--force', '--sign', '-', stagedOutput]);
  const architectures = validateBuiltHelper(stagedOutput);
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  rmSync(outputPath, { force: true });
  renameSync(stagedOutput, outputPath);
  console.log(`build-keychain-helper: PASS — protocol v1 ${architectures} digest ${sourceDigest}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
