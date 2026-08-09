import { Database } from 'bun:sqlite';
import { readdirSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';

import type { JsonObject, LedgerEntry } from '../../domain/types.ts';
import type {
  AdapterScanOptions,
  ScanBatch,
  ScanWarning,
  SourceTarget,
  StoredScanState,
} from '../../scan/types.ts';
import type { SourceAdapter, SourceDiscovery, SourceDiscoveryContext } from '../types.ts';
import { asString } from '../shared.ts';
import {
  ANTIGRAVITY_AGENT,
  ANTIGRAVITY_FIELD_MAP_VERSION,
  ANTIGRAVITY_PARSER_VERSION,
  ANTIGRAVITY_PROVIDER,
  parseGenMetadataBlob,
} from './records.ts';

const CURSOR_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export interface AntigravityAdapterOptions {
  /** Overrides ~/.gemini/antigravity-cli/conversations; used by tests. */
  readonly rootDirectory?: string;
}

/**
 * Reads the Antigravity CLI conversation databases (live WAL, one per
 * conversation) strictly read-only. Change detection fingerprints BOTH
 * the main db and its -wal sidecar — a live writer commits into the WAL
 * long before the main file changes. Any change triggers a full reparse;
 * response-id natural keys dedupe.
 */
export class AntigravityCliAdapter implements SourceAdapter {
  readonly agent = ANTIGRAVITY_AGENT;
  readonly parserVersion = ANTIGRAVITY_PARSER_VERSION;
  readonly #rootDirectory: string | null;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.#rootDirectory = options.rootDirectory ?? null;
  }

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery> {
    const root =
      this.#rootDirectory ??
      join(context.homeDirectory, '.gemini', 'antigravity-cli', 'conversations');
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return Promise.resolve({
        targets: [],
        warnings: [
          warning(
            this.agent,
            root,
            code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'source_missing',
            `antigravity conversations unavailable: ${describe(error)}`,
          ),
        ],
      });
    }
    const targets: SourceTarget[] = names
      .filter((name) => name.endsWith('.db'))
      .sort()
      .map((name) => ({
        agent: this.agent,
        path: join(root, name),
        kind: 'sqlite' as const,
        fingerprint: null,
      }));
    return Promise.resolve({ targets, warnings: [] });
  }

  async *scan(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
  ): AsyncIterable<ScanBatch> {
    let fingerprint: JsonObject;
    try {
      fingerprint = fileFingerprint(target.path);
    } catch (error) {
      yield emptyBatch([
        warning(this.agent, target.path, 'source_missing', `conversation db disappeared: ${describe(error)}`),
      ]);
      return;
    }

    if (!options.fullRescan && state !== null && sameFingerprint(state.cursorJson, fingerprint)) {
      yield {
        entries: [],
        nextOffset: 0,
        nextCursor: state.cursorJson,
        sourceMtime: state.mtime,
        sourceSize: state.size,
        tailPending: false,
        warnings: [],
      };
      return;
    }

    let rows: { idx: number; data: Uint8Array }[];
    let trajectoryId: string | null;
    let cascadeId: string | null;
    try {
      const db = new Database(target.path, { readonly: true, strict: true });
      try {
        db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
        db.exec('PRAGMA query_only = ON;');
        const meta = db
          .query<{ trajectory_id: string | null; cascade_id: string | null }, []>(
            'SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 1',
          )
          .get();
        trajectoryId = meta === null ? null : asString(meta.trajectory_id);
        cascadeId = meta === null ? null : asString(meta.cascade_id);
        rows = db
          .query<{ idx: number; data: Uint8Array }, []>(
            'SELECT idx, data FROM gen_metadata ORDER BY idx',
          )
          .all();
      } finally {
        db.close();
      }
    } catch (error) {
      yield emptyBatch([
        warning(this.agent, target.path, 'runtime', `cannot read conversation db: ${describe(error)}`),
      ]);
      return;
    }

    const warnings: ScanWarning[] = [];
    const entries: LedgerEntry[] = [];
    if (trajectoryId === null) {
      yield emptyBatch([
        warning(this.agent, target.path, 'invalid_record', 'conversation db has no trajectory id'),
      ]);
      return;
    }
    let invalidRows = 0;
    let fallbackIds = 0;
    let duplicateResponses = 0;
    const seenResponseIds = new Set<string>();
    for (const row of rows) {
      if (row.data.byteLength > MAX_BLOB_BYTES) {
        invalidRows += 1;
        continue;
      }
      const parsed = parseGenMetadataBlob(row.data);
      if (parsed.kind === 'skipped') {
        continue;
      }
      if (parsed.kind === 'invalid') {
        invalidRows += 1;
        continue;
      }
      const responseId =
        parsed.responseId !== null && parsed.responseId.trim().length > 0
          ? parsed.responseId
          : null;
      let naturalId: string;
      if (responseId !== null) {
        if (seenResponseIds.has(responseId)) {
          // a replayed duplicate of the SAME logical response — counting
          // it again would double the usage; skip and surface a warning
          duplicateResponses += 1;
          continue;
        }
        seenResponseIds.add(responseId);
        naturalId = `${trajectoryId}:response:${responseId}`;
      } else {
        fallbackIds += 1;
        naturalId = `${trajectoryId}:idx:${row.idx}`;
      }
      entries.push({
        tsUtc: parsed.tsUtc,
        agent: this.agent,
        account: null,
        provider: ANTIGRAVITY_PROVIDER,
        model: parsed.model,
        effort: null,
        promptText: null,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheWrite: 0,
        cacheRead: parsed.cacheRead,
        reasoningTokens: parsed.reasoningTokens,
        costUsd: null,
        sessionId: cascadeId ?? trajectoryId,
        cwd: null,
        naturalId,
        parserVersion: this.parserVersion,
        isSidechain: false,
        parentUuid: null,
      });
    }
    if (invalidRows > 0) {
      warnings.push(
        warning(this.agent, target.path, 'invalid_record', `${invalidRows} generation blobs failed the pinned field map (v${ANTIGRAVITY_FIELD_MAP_VERSION})`),
      );
    }
    if (duplicateResponses > 0) {
      warnings.push(
        warning(this.agent, target.path, 'natural_id_collision', `${duplicateResponses} duplicate response ids were skipped to avoid double counting`),
      );
    }
    if (fallbackIds > 0) {
      warnings.push(
        warning(this.agent, target.path, 'natural_id_collision', `${fallbackIds} generations without a usable response id used idx fallback keys`),
      );
    }

    yield {
      entries,
      nextOffset: 0,
      nextCursor: fingerprint,
      sourceMtime: fingerprint.mainMtime as number,
      sourceSize: fingerprint.mainSize as number,
      tailPending: false,
      warnings,
    };
  }
}

function fileFingerprint(path: string): JsonObject {
  const main = statSync(path);
  const wal = statSafe(`${path}-wal`);
  return {
    version: CURSOR_VERSION,
    device: main.dev,
    inode: main.ino,
    mainMtime: Math.floor(main.mtimeMs),
    mainSize: main.size,
    walMtime: wal === null ? null : Math.floor(wal.mtimeMs),
    walSize: wal === null ? null : wal.size,
    fieldMapVersion: ANTIGRAVITY_FIELD_MAP_VERSION,
  };
}

function sameFingerprint(stored: JsonObject, current: JsonObject): boolean {
  const keys = [
    'version',
    'device',
    'inode',
    'mainMtime',
    'mainSize',
    'walMtime',
    'walSize',
    'fieldMapVersion',
  ] as const;
  return keys.every((key) => stored[key] === current[key]);
}

function statSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
