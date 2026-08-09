import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const FILE_MODE = 0o600;

/**
 * Atomic 0600 write. The mode is applied to the temp file before the
 * rename so the destination is never briefly world-readable, and a
 * failed write leaves the previous contents untouched.
 */
export function writeFilePrivate(path: string, text: string): void {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, { mode: FILE_MODE });
    chmodSync(temp, FILE_MODE);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
