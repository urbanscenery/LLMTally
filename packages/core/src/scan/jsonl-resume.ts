import { statSync } from 'node:fs';

import { hashFileRange } from './file-discovery.ts';

export const HEAD_SAMPLE_BYTES = 4096;

/** File identity persisted in cursor_json to detect rotation/rewrites. */
export interface CursorFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly headSha256: string;
  readonly headSampleBytes: number;
}

export interface SourceFileStats {
  readonly size: number;
  readonly mtime: number;
  readonly device: number;
  readonly inode: number;
}

export function statSourceFile(path: string): SourceFileStats {
  const stats = statSync(path);
  return {
    size: stats.size,
    mtime: Math.floor(stats.mtimeMs),
    device: stats.dev,
    inode: stats.ino,
  };
}

/**
 * The head sample length is capped at the scanned ceiling so appends to
 * files smaller than the sample window do not change the recorded hash
 * and trigger a spurious reset.
 */
export function buildFileIdentity(
  path: string,
  stats: SourceFileStats,
  ceiling: number,
): CursorFileIdentity {
  const headSampleBytes = Math.min(HEAD_SAMPLE_BYTES, ceiling);
  return {
    device: stats.device,
    inode: stats.inode,
    headSha256: hashFileRange(path, 0, headSampleBytes),
    headSampleBytes,
  };
}

export interface JsonlResumeInput {
  readonly path: string;
  readonly lastOffset: number;
  readonly cursorVersion: unknown;
  readonly expectedCursorVersion: number;
  readonly cursorFile: unknown;
  readonly stats: SourceFileStats;
}

/** Returns null when resuming from the stored offset is safe. */
export function jsonlResumeResetReason(input: JsonlResumeInput): string | null {
  if (input.cursorVersion !== input.expectedCursorVersion) {
    return 'unsupported cursor version';
  }
  if (!Number.isInteger(input.lastOffset) || input.lastOffset < 0) {
    return 'stored offset is not a non-negative integer';
  }
  if (input.stats.size < input.lastOffset) {
    return 'file shrank below the committed offset';
  }
  const file = asCursorFile(input.cursorFile);
  if (file === null) {
    return 'stored cursor has no valid file identity';
  }
  if (file.device !== input.stats.device || file.inode !== input.stats.inode) {
    return 'file identity (device/inode) changed';
  }
  const currentHead = hashFileRange(input.path, 0, file.headSampleBytes);
  if (currentHead !== file.headSha256) {
    return 'file head content changed';
  }
  return null;
}

export function asCursorFile(value: unknown): CursorFileIdentity | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !isNonNegativeInteger(record.device) ||
    !isNonNegativeInteger(record.inode) ||
    typeof record.headSha256 !== 'string' ||
    !isNonNegativeInteger(record.headSampleBytes) ||
    record.headSampleBytes > HEAD_SAMPLE_BYTES
  ) {
    return null;
  }
  return {
    device: record.device,
    inode: record.inode,
    headSha256: record.headSha256,
    headSampleBytes: record.headSampleBytes,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
