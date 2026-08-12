import type { JsonObject, LedgerEntry } from '../domain/types.ts';

export type SourceKind = 'jsonl' | 'sqlite' | 'json' | 'directory';

export interface FileFingerprint {
  readonly device: number | null;
  readonly inode: number | null;
  readonly headSha256: string;
  readonly tailSha256: string;
}

export interface SourceTarget {
  readonly agent: string;
  readonly path: string;
  readonly kind: SourceKind;
  readonly fingerprint: FileFingerprint | null;
}

export interface StoredScanState {
  readonly agent: string;
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
  readonly lastOffset: number;
  readonly cursorJson: JsonObject;
}

export interface AdapterScanOptions {
  readonly fullRescan: boolean;
  readonly scanCeilingBytes: number | null;
}

export type ScanWarningCode =
  | 'source_missing'
  | 'permission_denied'
  | 'invalid_utf8'
  | 'malformed_json'
  | 'invalid_record'
  | 'prompt_unresolved'
  | 'natural_id_collision'
  | 'cursor_reset'
  | 'runtime';

export interface ScanWarning {
  readonly code: ScanWarningCode;
  readonly agent: string;
  readonly path: string | null;
  readonly offset: number | null;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface ScanBatch<TCursor extends JsonObject = JsonObject> {
  readonly entries: readonly LedgerEntry[];
  readonly nextOffset: number | null;
  readonly nextCursor: TCursor;
  readonly sourceMtime: number | null;
  readonly sourceSize: number | null;
  readonly tailPending: boolean;
  readonly warnings: readonly ScanWarning[];
}

export interface CommitBatchInput {
  readonly target: SourceTarget;
  readonly batch: ScanBatch;
}

export interface CommitBatchResult {
  readonly insertedRows: number;
  readonly ignoredRows: number;
  readonly committedOffset: number | null;
}

export interface LedgerRepository {
  getScanState(agent: string, path: string): StoredScanState | null;
  commitBatch(input: CommitBatchInput): CommitBatchResult;
  /**
   * Ages out prompt TEXT observed before `cutoffUtc` (sets it to NULL,
   * which the FTS triggers propagate); every aggregate column stays.
   * Optional so repository fakes need not care. Returns aged row count.
   */
  agePrompts?(cutoffUtc: number): number;
  migrate(): void;
  close(): void;
}

export interface ScanRequest {
  readonly agent: string | null;
  readonly fullRescan: boolean;
  readonly databasePath: string;
}

export interface ScanSummary {
  readonly agent: string | null;
  readonly databasePath: string;
  readonly discoveredFiles: number;
  readonly scannedFiles: number;
  readonly missingFiles: number;
  readonly insertedRows: number;
  readonly ignoredRows: number;
  readonly malformedLines: number;
  readonly pendingTails: number;
  /** Bounded sample of warnings; warningTotal carries the true count. */
  readonly warnings: readonly ScanWarning[];
  readonly warningCounts: Readonly<Record<string, number>>;
  readonly warningTotal: number;
  readonly startedAtUtc: number;
  readonly finishedAtUtc: number;
}

export interface ScanCoordinator {
  run(request: ScanRequest): Promise<ScanSummary>;
}
