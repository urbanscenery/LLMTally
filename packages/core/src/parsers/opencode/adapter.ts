import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { LedgerEntry } from '../../domain/types.ts';
import type {
  AdapterScanOptions,
  ScanBatch,
  ScanWarning,
  SourceTarget,
  StoredScanState,
} from '../../scan/types.ts';
import type { SourceAdapter, SourceDiscovery, SourceDiscoveryContext } from '../types.ts';
import { OPENCODE_AGENT, OPENCODE_CURSOR_VERSION, OPENCODE_PARSER_VERSION } from './constants.ts';
import { resolveOpenCodeCursor } from './cursor.ts';
import { groupJoinedRows, normalizeAssistant } from './records.ts';
import { fetchJoinedRows, validateOpenCodeSchema } from './query.ts';
import { openOpenCodeSourceDatabase } from './source-db.ts';

const BATCH_MAX_ENTRIES = 2000;

export interface OpenCodeAdapterOptions {
  /** Overrides ~/.local/share/opencode/opencode.db; used by tests. */
  readonly databasePath?: string;
}

export class OpenCodeAdapter implements SourceAdapter {
  readonly agent = OPENCODE_AGENT;
  readonly parserVersion = OPENCODE_PARSER_VERSION;
  readonly #databasePath: string | null;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#databasePath = options.databasePath ?? null;
  }

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery> {
    const path =
      this.#databasePath ??
      join(context.homeDirectory, '.local', 'share', 'opencode', 'opencode.db');
    try {
      const stats = statSync(path);
      if (!stats.isFile()) {
        return Promise.resolve({
          targets: [],
          warnings: [warning(this.agent, path, 'source_missing', 'opencode database path is not a regular file')],
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return Promise.resolve({
        targets: [],
        warnings: [
          warning(
            this.agent,
            path,
            code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'source_missing',
            `opencode database unavailable: ${describeError(error)}`,
          ),
        ],
      });
    }
    return Promise.resolve({
      targets: [{ agent: this.agent, path, kind: 'sqlite', fingerprint: null }],
      warnings: [],
    });
  }

  async *scan(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
  ): AsyncIterable<ScanBatch> {
    let sourceMtime: number;
    let sourceSize: number;
    let identity: { device: number; inode: number };
    try {
      const stats = statSync(target.path);
      sourceMtime = Math.floor(stats.mtimeMs);
      sourceSize = stats.size;
      identity = { device: stats.dev, inode: stats.ino };
    } catch (error) {
      yield emptyBatch([
        warning(this.agent, target.path, 'source_missing', `source database disappeared before scan: ${describeError(error)}`),
      ]);
      return;
    }

    const cursor = resolveOpenCodeCursor(state, options.fullRescan, identity);
    const warnings: ScanWarning[] = [];
    if (cursor.resetReason !== null) {
      warnings.push(
        warning(this.agent, target.path, 'cursor_reset', `cursor reset, rescanning from start: ${cursor.resetReason}`),
      );
    }

    // materialize inside one short-lived read-only connection so the
    // ledger commit never runs while the live source is held open;
    // yields only happen after the connection is closed
    let rows;
    let sinceUpdatedMs = cursor.updatedMs;
    let schemaIssue: string | null = null;
    try {
      const db = openOpenCodeSourceDatabase(target.path);
      try {
        schemaIssue = validateOpenCodeSchema(db);
        if (schemaIssue === null) {
          // an in-place restore keeps device/inode but rolls timestamps
          // back — a watermark above everything in the file must reset
          const maxRow = db
            .query<{ m: number | null }, []>('SELECT MAX(time_updated) AS m FROM message')
            .get();
          if (maxRow !== null && typeof maxRow.m === 'number' && maxRow.m < sinceUpdatedMs) {
            warnings.push(
              warning(this.agent, target.path, 'cursor_reset', 'cursor reset, rescanning from start: source database appears restored to an older state'),
            );
            sinceUpdatedMs = 0;
          }
          rows = fetchJoinedRows(db, sinceUpdatedMs);
        }
      } finally {
        db.close();
      }
    } catch (error) {
      yield emptyBatch([
        ...warnings,
        warning(this.agent, target.path, 'runtime', `cannot read source database: ${describeError(error)}`),
      ]);
      return;
    }
    if (schemaIssue !== null || rows === undefined) {
      yield emptyBatch([
        ...warnings,
        warning(this.agent, target.path, 'invalid_record', `unsupported source schema: ${schemaIssue ?? 'unknown'}`),
      ]);
      return;
    }

    let globalWatermark = sinceUpdatedMs;
    const collected: { entry: LedgerEntry; timeUpdated: number }[] = [];
    for (const candidate of groupJoinedRows(rows)) {
      globalWatermark = Math.max(globalWatermark, candidate.timeUpdated);
      const normalized = normalizeAssistant(candidate);
      if (normalized.kind === 'invalid') {
        warnings.push(
          warning(this.agent, target.path, 'invalid_record', `message ${candidate.id}: ${normalized.reason}`),
        );
        continue;
      }
      if (normalized.hasMalformedPart) {
        warnings.push(
          warning(this.agent, target.path, 'malformed_json', `message ${candidate.id}: prompt part is not valid JSON`),
        );
      }
      if (normalized.hasInvalidCost) {
        warnings.push(
          warning(this.agent, target.path, 'invalid_record', `message ${candidate.id}: source cost is not a non-negative number`),
        );
      }
      collected.push({ entry: normalized.entry, timeUpdated: candidate.timeUpdated });
    }

    // rows are ordered by time_updated, so an intermediate chunk only
    // advances the watermark to its own last committed row — a crash
    // between chunk commits must not skip the uncommitted remainder
    let chunkWatermark = sinceUpdatedMs;
    for (let index = 0; index < collected.length; index += BATCH_MAX_ENTRIES) {
      const chunk = collected.slice(index, index + BATCH_MAX_ENTRIES);
      const isLast = index + BATCH_MAX_ENTRIES >= collected.length;
      chunkWatermark = Math.max(chunkWatermark, chunk[chunk.length - 1]?.timeUpdated ?? 0);
      yield {
        entries: chunk.map((item) => item.entry),
        nextOffset: 0,
        nextCursor: {
          version: OPENCODE_CURSOR_VERSION,
          updatedMs: isLast ? globalWatermark : chunkWatermark,
          device: identity.device,
          inode: identity.inode,
        },
        sourceMtime,
        sourceSize,
        tailPending: false,
        warnings: isLast ? warnings : [],
      };
    }
    if (collected.length === 0) {
      yield {
        entries: [],
        nextOffset: 0,
        nextCursor: {
          version: OPENCODE_CURSOR_VERSION,
          updatedMs: globalWatermark,
          device: identity.device,
          inode: identity.inode,
        },
        sourceMtime,
        sourceSize,
        tailPending: false,
        warnings,
      };
    }
  }
}

function emptyBatch(warnings: readonly ScanWarning[]): ScanBatch {
  return {
    entries: [],
    nextOffset: null,
    nextCursor: {},
    sourceMtime: null,
    sourceSize: null,
    tailPending: false,
    warnings,
  };
}

function warning(
  agent: string,
  path: string,
  code: ScanWarning['code'],
  message: string,
): ScanWarning {
  return { code, agent, path, offset: null, message, recoverable: true };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
