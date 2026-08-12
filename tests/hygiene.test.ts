import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('source tree hygiene (review regression)', () => {
  test('no source file contains stray control bytes', () => {
    // A literal NUL once slipped into accounts/discovery.ts and made
    // git treat the file as binary; only \n and \t are legitimate.
    const roots = [join(import.meta.dir, '..', 'packages')];
    const offenders: string[] = [];
    while (roots.length > 0) {
      const dir = roots.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          roots.push(path);
          continue;
        }
        if (!/\.(ts|sql|md|json)$/.test(entry.name)) {
          continue;
        }
        const content = readFileSync(path, 'utf8');
        for (let index = 0; index < content.length; index += 1) {
          const code = content.charCodeAt(index);
          const isControl = (code < 32 && code !== 10 && code !== 9) || code === 127;
          if (isControl) {
            offenders.push(`${path} @${index} (0x${code.toString(16)})`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The published package has to carry everything the runtime needs to
 * resolve an import. Cross-package specifiers (`@llmtally/core/…`) are
 * resolved from the workspace symlinks during development and from the
 * tsconfig `paths` map everywhere else — so a tarball without that map
 * installs fine and then dies on the first import.
 */
describe('publishable package completeness', () => {
  const root = join(import.meta.dir, '..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    files: string[];
    bin: Record<string, string>;
  };

  test('the files list ships the path map the entry point depends on', () => {
    // Arrange — the entry really does use a cross-package specifier
    const entry = readFileSync(join(root, manifest.bin.llmtally ?? ''), 'utf8');

    // Assert
    expect(entry).toContain('@llmtally/');
    expect(manifest.files).toContain('tsconfig.json');
  });

  test('every packaged path map target is inside the packaged files', () => {
    // Arrange
    const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };

    // Act — where each mapping points, relative to the package root
    const targets = Object.values(tsconfig.compilerOptions.paths)
      .flat()
      .map((target) => target.replace(/^\.\//, ''));

    // Assert — a mapping into a directory that is not shipped would
    // resolve during development and fail only after publishing
    for (const target of targets) {
      expect(manifest.files.some((entry) => target.startsWith(entry))).toBe(true);
    }
  });
});
