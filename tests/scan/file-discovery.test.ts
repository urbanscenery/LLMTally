import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverJsonlFiles, fingerprintFile } from '@llmtally/core/scan/file-discovery.ts';
import { makeTempDir } from '../helpers.ts';

function fingerprintOf(path: string) {
  const stats = statSync(path);
  return fingerprintFile(path, stats.size, stats.dev, stats.ino);
}

describe('discoverJsonlFiles', () => {
  test('finds nested jsonl files sorted by path and skips other extensions', () => {
    // Arrange
    const root = makeTempDir();
    mkdirSync(join(root, 'project-b'));
    mkdirSync(join(root, 'project-a'));
    writeFileSync(join(root, 'project-b', 'session.jsonl'), '{}\n');
    writeFileSync(join(root, 'project-a', 'session.jsonl'), '{}\n');
    writeFileSync(join(root, 'project-a', 'notes.txt'), 'not a log');

    // Act
    const result = discoverJsonlFiles('claude-code', root);

    // Assert
    expect(result.targets.map((target) => target.path)).toEqual([
      join(root, 'project-a', 'session.jsonl'),
      join(root, 'project-b', 'session.jsonl'),
    ]);
    expect(result.warnings).toHaveLength(0);
    expect(result.targets[0]?.fingerprint?.headSha256).toStartWith('sha256:');
  });

  test('returns a recoverable source_missing warning when the root does not exist', () => {
    // Arrange
    const root = join(makeTempDir(), 'does-not-exist');

    // Act
    const result = discoverJsonlFiles('claude-code', root);

    // Assert
    expect(result.targets).toHaveLength(0);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'source_missing', recoverable: true, path: root }),
    ]);
  });

  test('scans symlinked duplicates of the same inode only once', () => {
    // Arrange
    const root = makeTempDir();
    writeFileSync(join(root, 'real.jsonl'), '{}\n');
    symlinkSync(join(root, 'real.jsonl'), join(root, 'alias.jsonl'));

    // Act
    const result = discoverJsonlFiles('claude-code', root);

    // Assert
    expect(result.targets).toHaveLength(1);
  });
});

describe('fingerprintFile', () => {
  test('keeps the head hash stable while appends change the tail hash', () => {
    // Arrange
    const root = makeTempDir();
    const path = join(root, 'session.jsonl');
    writeFileSync(path, `${'x'.repeat(6000)}\n`);
    const before = fingerprintOf(path);

    // Act
    appendFileSync(path, '{"more":true}\n');
    const after = fingerprintOf(path);

    // Assert
    expect(after.headSha256).toBe(before.headSha256);
    expect(after.tailSha256).not.toBe(before.tailSha256);
    expect(after.inode).toBe(before.inode);
  });

  test('produces different hashes for different content', () => {
    // Arrange
    const root = makeTempDir();
    const pathA = join(root, 'a.jsonl');
    const pathB = join(root, 'b.jsonl');
    writeFileSync(pathA, '{"a":1}\n');
    writeFileSync(pathB, '{"b":2}\n');

    // Act & Assert
    expect(fingerprintOf(pathA).headSha256).not.toBe(fingerprintOf(pathB).headSha256);
  });
});
