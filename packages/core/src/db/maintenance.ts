/**
 * Ledger space accounting and compaction (audit D-07). SQLite reuses
 * pages freed by deletes and by the prompt-retention pass, so the file
 * stops growing — but it never shrinks on its own, and neither does a
 * WAL that no checkpoint truncated. This module says how much space is
 * reclaimable and reclaims it on demand; nothing here runs
 * automatically, because VACUUM rewrites the whole database and a
 * multi-hundred-MB ledger blocks for seconds.
 */
import { statSync } from 'node:fs';

import { acquireScanLock } from '../scan/lock.ts';
import { openDatabase } from './connection.ts';

export class MaintenanceError extends Error {
  override readonly name = 'MaintenanceError';
}

export interface LedgerSpaceReport {
  readonly fileBytes: number;
  readonly walBytes: number;
  /** Bytes sitting on the freelist — what a VACUUM would return. */
  readonly reclaimableBytes: number;
}

export interface CompactResult {
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly reclaimedBytes: number;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Read-only space report; null when the ledger does not exist yet. */
export function ledgerSpaceReport(databasePath: string): LedgerSpaceReport | null {
  const fileBytes = fileSize(databasePath);
  if (fileBytes === 0) {
    return null;
  }
  const db = openDatabase(databasePath);
  try {
    const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 0;
    const freelist =
      db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0;
    return {
      fileBytes,
      walBytes: fileSize(`${databasePath}-wal`),
      reclaimableBytes: freelist * pageSize,
    };
  } finally {
    db.close();
  }
}

/**
 * Checkpoints the WAL and VACUUMs the ledger under the scan lock — the
 * same lock scans take, so compaction can never interleave with a
 * collection writing rows. A held lock fails loudly ("scan busy")
 * instead of queueing behind work of unknown length.
 */
export function compactLedger(databasePath: string): CompactResult {
  const beforeBytes = fileSize(databasePath);
  if (beforeBytes === 0) {
    throw new MaintenanceError(`no ledger at ${databasePath}`);
  }
  const lock = acquireScanLock(`${databasePath}.lock`);
  try {
    const db = openDatabase(databasePath);
    try {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // the VACUUM below still checkpoints what matters
      }
      db.exec('VACUUM;');
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
  const afterBytes = fileSize(databasePath);
  return {
    beforeBytes,
    afterBytes,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
  };
}
