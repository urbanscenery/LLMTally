import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

const LOCK_DIRECTORY_MODE = 0o700;

export class ScanLockError extends Error {
  override readonly name = 'ScanLockError';

  constructor(
    lockPath: string,
    readonly holderPid: number | null,
  ) {
    super(
      holderPid === null
        ? `another scan holds the lock at ${lockPath}`
        : `another scan (pid ${holderPid}) holds the lock at ${lockPath}`,
    );
  }
}

export interface ScanLock {
  readonly path: string;
  release(): void;
}

/**
 * SQLite allows only one writer, and two concurrent scans could each read
 * a stale cursor and overwrite the other's scan_state. This process-level
 * lock serializes scans; a lock whose holder pid is no longer alive is
 * treated as stale and taken over.
 */
export function acquireScanLock(lockPath: string): ScanLock {
  mkdirSync(dirname(lockPath), { recursive: true, mode: LOCK_DIRECTORY_MODE });
  if (tryCreateLockFile(lockPath)) {
    return makeLock(lockPath);
  }
  const holderPid = readHolderPid(lockPath);
  if (holderPid !== null && isPidAlive(holderPid)) {
    throw new ScanLockError(lockPath, holderPid);
  }
  // rename is atomic, so exactly one contender wins the stale takeover;
  // an unlink-then-create sequence would let a slow contender delete the
  // winner's freshly created lock
  takeOverStaleLock(lockPath);
  if (tryCreateLockFile(lockPath)) {
    return makeLock(lockPath);
  }
  throw new ScanLockError(lockPath, readHolderPid(lockPath));
}

function makeLock(lockPath: string): ScanLock {
  return {
    path: lockPath,
    release(): void {
      // only the owner may release: a pid check prevents deleting a lock
      // that another process acquired after ours was already released
      if (readHolderPid(lockPath) === process.pid) {
        removeLockFile(lockPath);
      }
    },
  };
}

function takeOverStaleLock(lockPath: string): void {
  const stalePath = `${lockPath}.stale.${process.pid}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  removeLockFile(stalePath);
}

function tryCreateLockFile(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeLockFile(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
