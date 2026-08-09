import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { FileFingerprint, ScanWarning, SourceTarget } from './types.ts';

const FINGERPRINT_SAMPLE_BYTES = 4096;
const JSONL_EXTENSION = '.jsonl';

export interface FileDiscoveryResult {
  readonly targets: readonly SourceTarget[];
  readonly warnings: readonly ScanWarning[];
}

/**
 * Finds every *.jsonl regular file under rootDirectory, deduplicated by
 * device/inode so symlinked paths are scanned once, sorted by path for a
 * deterministic scan order. A missing root is a recoverable condition:
 * the ledger must still be created and other sources must keep scanning.
 */
export function discoverJsonlFiles(agent: string, rootDirectory: string): FileDiscoveryResult {
  let relativePaths: readonly string[];
  try {
    relativePaths = readdirSync(rootDirectory, { recursive: true, encoding: 'utf8' });
  } catch (error) {
    return { targets: [], warnings: [rootWarning(agent, rootDirectory, error)] };
  }

  const targets: SourceTarget[] = [];
  const warnings: ScanWarning[] = [];
  const seenIdentities = new Set<string>();

  const jsonlPaths = relativePaths
    .filter((relative) => relative.endsWith(JSONL_EXTENSION))
    .map((relative) => join(rootDirectory, relative))
    .sort();

  for (const path of jsonlPaths) {
    try {
      const stats = statSync(path);
      if (!stats.isFile()) {
        continue;
      }
      const identity = `${stats.dev}:${stats.ino}`;
      if (seenIdentities.has(identity)) {
        continue;
      }
      seenIdentities.add(identity);
      targets.push({
        agent,
        path,
        kind: 'jsonl',
        fingerprint: fingerprintFile(path, stats.size, stats.dev, stats.ino),
      });
    } catch (error) {
      warnings.push({
        code: 'permission_denied',
        agent,
        path,
        offset: null,
        message: `cannot stat or sample source file: ${describeError(error)}`,
        recoverable: true,
      });
    }
  }

  return { targets, warnings };
}

export function fingerprintFile(
  path: string,
  size: number,
  device: number,
  inode: number,
): FileFingerprint {
  const fd = openSync(path, 'r');
  try {
    const headLength = Math.min(FINGERPRINT_SAMPLE_BYTES, size);
    const tailLength = Math.min(FINGERPRINT_SAMPLE_BYTES, size);
    const tailPosition = Math.max(0, size - tailLength);
    return {
      device,
      inode,
      headSha256: hashRange(fd, 0, headLength),
      tailSha256: hashRange(fd, tailPosition, tailLength),
    };
  } finally {
    closeSync(fd);
  }
}

/** Hashes a byte range of a file; used for cursor head-sample comparisons. */
export function hashFileRange(path: string, position: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    return hashRange(fd, position, length);
  } finally {
    closeSync(fd);
  }
}

function hashRange(fd: number, position: number, length: number): string {
  const buffer = Buffer.alloc(length);
  const bytesRead = length === 0 ? 0 : readSync(fd, buffer, 0, length, position);
  const digest = createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  return `sha256:${digest}`;
}

function rootWarning(agent: string, rootDirectory: string, error: unknown): ScanWarning {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    code: code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'source_missing',
    agent,
    path: rootDirectory,
    offset: null,
    message: `source root unavailable: ${describeError(error)}`,
    recoverable: true,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
