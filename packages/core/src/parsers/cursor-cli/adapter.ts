import { join } from 'node:path';

import type { JsonObject, LedgerEntry } from '../../domain/types.ts';
import { discoverJsonlFiles } from '../../scan/file-discovery.ts';
import { readJsonlLines } from '../../scan/jsonl-reader.ts';
import type { SourceFileStats } from '../../scan/jsonl-resume.ts';
import { buildFileIdentity, jsonlResumeResetReason, statSourceFile } from '../../scan/jsonl-resume.ts';
import type {
  AdapterScanOptions,
  ScanBatch,
  ScanWarning,
  SourceTarget,
  StoredScanState,
} from '../../scan/types.ts';
import type { SourceAdapter, SourceDiscovery, SourceDiscoveryContext } from '../types.ts';
import {
  CURSOR_CLI_AGENT,
  CURSOR_CLI_CURSOR_VERSION,
  CURSOR_CLI_PARSER_VERSION,
  CURSOR_CLI_TRANSCRIPTS_SEGMENT,
  CURSOR_CLI_UNKNOWN_MODEL,
} from './constants.ts';
import { CursorCliPromptBuffer } from './prompt-buffer.ts';
import type { CursorCliUsage } from './records.ts';
import {
  classifyCursorCliLine,
  cursorCliProviderFromModel,
  isCursorCliCandidateLine,
} from './records.ts';
import { readCursorCliSessionMeta } from './session-meta.ts';

const BATCH_MAX_ENTRIES = 2000;
const MILLISECONDS_PER_SECOND = 1000;

export interface CursorCliAdapterOptions {
  /** Overrides ~/.cursor/projects; used by tests. */
  readonly rootDirectory?: string;
}

/**
 * Cursor Agent CLI (and the IDE Agent that shares the same transcript
 * tree) writes Claude-compatible JSONL under
 * `~/.cursor/projects/<cwd>/agent-transcripts/`. Usage is optional —
 * interactive transcripts often have none — so a file with only user
 * turns is a successful empty scan, not a parse failure.
 */
export class CursorCliAdapter implements SourceAdapter {
  readonly agent = CURSOR_CLI_AGENT;
  readonly parserVersion = CURSOR_CLI_PARSER_VERSION;
  readonly #rootDirectory: string | null;

  constructor(options: CursorCliAdapterOptions = {}) {
    this.#rootDirectory = options.rootDirectory ?? null;
  }

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery> {
    const root = this.#rootDirectory ?? join(context.homeDirectory, '.cursor', 'projects');
    const discovery = discoverJsonlFiles(this.agent, root);
    return Promise.resolve({
      targets: discovery.targets.filter((target) =>
        target.path.includes(CURSOR_CLI_TRANSCRIPTS_SEGMENT),
      ),
      warnings: discovery.warnings,
    });
  }

  async *scan(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
  ): AsyncIterable<ScanBatch> {
    let stats: SourceFileStats;
    try {
      stats = statSourceFile(target.path);
    } catch (error) {
      yield emptyBatch([sourceMissingWarning(this.agent, target.path, error)]);
      return;
    }

    const ceiling = Math.min(options.scanCeilingBytes ?? stats.size, stats.size);
    const resume = this.#resolveResume(target, state, options, stats);
    const fileIdentity = buildFileIdentity(target.path, stats, ceiling);
    const meta = readCursorCliSessionMeta(target.path);
    const buffer = resume.buffer;
    const fileMtimeUtc = Math.floor(stats.mtime / MILLISECONDS_PER_SECOND);
    let entries: LedgerEntry[] = [];
    let warnings: ScanWarning[] = [...resume.warnings];

    const makeBatch = (nextOffset: number, tailPending: boolean): ScanBatch => ({
      entries,
      nextOffset,
      nextCursor: buildCursor(fileIdentity, buffer),
      sourceMtime: stats.mtime,
      sourceSize: ceiling,
      tailPending,
      warnings,
    });

    const iterator = readJsonlLines(target.path, resume.startOffset, ceiling);
    try {
      let step = iterator.next();
      let lastLineEnd = resume.startOffset;
      while (!step.done) {
        const line = step.value;
        if (line.invalidUtf8 || line.text === null) {
          warnings.push(
            line.oversized
              ? lineWarning(
                  this.agent,
                  target.path,
                  line.startOffset,
                  'oversized_line',
                  'line exceeds the 32MiB cap; skipped',
                )
              : lineWarning(
                  this.agent,
                  target.path,
                  line.startOffset,
                  'invalid_utf8',
                  'line is not valid UTF-8',
                ),
          );
        } else if (line.text.length > 0 && isCursorCliCandidateLine(line.text)) {
          this.#handleLine(
            line.text,
            line.startOffset,
            target,
            meta,
            buffer,
            entries,
            warnings,
            fileMtimeUtc,
          );
        }
        lastLineEnd = line.endOffset;
        if (entries.length >= BATCH_MAX_ENTRIES || warnings.length >= BATCH_MAX_ENTRIES) {
          yield makeBatch(lastLineEnd, false);
          entries = [];
          warnings = [];
        }
        step = iterator.next();
      }
      const tail = step.value;
      yield makeBatch(tail.nextOffset, tail.tailPending);
    } finally {
      iterator.return({ tailPending: false, tailStartOffset: null, nextOffset: 0 });
    }
  }

  #handleLine(
    text: string,
    startOffset: number,
    target: SourceTarget,
    meta: ReturnType<typeof readCursorCliSessionMeta>,
    buffer: CursorCliPromptBuffer,
    entries: LedgerEntry[],
    warnings: ScanWarning[],
    fileMtimeUtc: number,
  ): void {
    const record = classifyCursorCliLine(text, fileMtimeUtc);
    switch (record.kind) {
      case 'user':
        buffer.set({
          text: record.text,
          promptKey: record.promptKey ?? promptKeyFor(record.sessionId ?? meta.sessionId, null),
        });
        return;
      case 'meta':
        return;
      case 'usage': {
        const prompt = buffer.take();
        const sessionId = record.usage.sessionId ?? meta.sessionId;
        const model =
          record.usage.model.length > 0 ? record.usage.model : CURSOR_CLI_UNKNOWN_MODEL;
        const entry = this.#entryFrom(
          record.usage,
          meta,
          sessionId,
          prompt?.text ?? null,
          prompt?.promptKey ?? promptKeyFor(sessionId, record.usage.promptId),
          naturalIdFor(
            sessionId,
            record.usage.requestId,
            record.usage.promptId,
            startOffset,
            model,
          ),
          model,
        );
        upsertUsage(entries, entry);
        return;
      }
      case 'malformed':
        warnings.push(
          lineWarning(this.agent, target.path, startOffset, 'malformed_json', record.reason),
        );
        return;
      case 'invalid':
        warnings.push(
          lineWarning(this.agent, target.path, startOffset, 'invalid_record', record.reason),
        );
        return;
      case 'skipped':
        return;
    }
  }

  #entryFrom(
    usage: CursorCliUsage,
    meta: ReturnType<typeof readCursorCliSessionMeta>,
    sessionId: string | null,
    promptText: string | null,
    promptKey: string | null,
    naturalId: string,
    model: string,
  ): LedgerEntry {
    return {
      tsUtc: usage.tsUtc,
      agent: this.agent,
      account: null,
      provider: cursorCliProviderFromModel(model),
      model,
      effort: usage.effort,
      promptText,
      promptKey,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      reasoningTokens: usage.reasoningTokens,
      costUsd: null,
      sessionId,
      cwd: meta.cwd,
      naturalId,
      parserVersion: this.parserVersion,
      isSidechain: usage.isSidechain,
      parentUuid: null,
    };
  }

  #resolveResume(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
    stats: SourceFileStats,
  ): {
    startOffset: number;
    buffer: CursorCliPromptBuffer;
    warnings: readonly ScanWarning[];
  } {
    const fresh = {
      startOffset: 0,
      buffer: new CursorCliPromptBuffer(),
      warnings: [] as readonly ScanWarning[],
    };
    if (options.fullRescan || state === null) {
      return fresh;
    }
    const reason = jsonlResumeResetReason({
      path: target.path,
      lastOffset: state.lastOffset,
      cursorVersion: state.cursorJson.version,
      expectedCursorVersion: CURSOR_CLI_CURSOR_VERSION,
      cursorFile: state.cursorJson.file,
      stats,
    });
    if (reason !== null) {
      return {
        ...fresh,
        warnings: [
          {
            code: 'cursor_reset',
            agent: this.agent,
            path: target.path,
            offset: null,
            message: `cursor reset, rescanning from start: ${reason}`,
            recoverable: true,
          },
        ],
      };
    }
    return {
      startOffset: Math.min(state.lastOffset, stats.size),
      buffer: CursorCliPromptBuffer.fromJson(state.cursorJson.pendingPrompt),
      warnings: [],
    };
  }
}

/**
 * Prefer request_id, then prompt_id, then the byte offset. UNIQUE(agent,
 * natural_id) makes a replay a no-op.
 */
function naturalIdFor(
  sessionId: string | null,
  requestId: string | null,
  promptId: string | null,
  startOffset: number,
  model: string,
): string {
  const turn = requestId ?? promptId ?? `@${startOffset}`;
  return `${sessionId ?? 'unknown'}:${turn}:${model.length > 0 ? model : CURSOR_CLI_UNKNOWN_MODEL}`;
}

function promptKeyFor(sessionId: string | null, promptId: string | null): string | null {
  if (promptId === null) {
    return sessionId === null ? null : `${sessionId}:prompt`;
  }
  return `${sessionId ?? 'unknown'}:${promptId}`;
}

/** Same request_id from assistant + result: keep the more complete usage. */
function upsertUsage(entries: LedgerEntry[], entry: LedgerEntry): void {
  const index = entries.findIndex((existing) => existing.naturalId === entry.naturalId);
  if (index === -1) {
    entries.push(entry);
    return;
  }
  const current = entries[index];
  if (current === undefined) {
    entries.push(entry);
    return;
  }
  const nextSum = entry.inputTokens + entry.outputTokens + entry.cacheRead + entry.cacheWrite;
  const currentSum =
    current.inputTokens + current.outputTokens + current.cacheRead + current.cacheWrite;
  if (nextSum > currentSum) {
    entries[index] = entry;
  }
}

function buildCursor(
  file: ReturnType<typeof buildFileIdentity>,
  buffer: CursorCliPromptBuffer,
): JsonObject {
  const pending = buffer.toJson();
  return {
    version: CURSOR_CLI_CURSOR_VERSION,
    file: { ...file },
    pendingPrompt: pending === null ? null : { ...pending },
  };
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

function sourceMissingWarning(agent: string, path: string, error: unknown): ScanWarning {
  return {
    code: 'source_missing',
    agent,
    path,
    offset: null,
    message: `source file disappeared before scan: ${error instanceof Error ? error.message : String(error)}`,
    recoverable: true,
  };
}

function lineWarning(
  agent: string,
  path: string,
  offset: number,
  code: ScanWarning['code'],
  message: string,
): ScanWarning {
  return { code, agent, path, offset, message, recoverable: true };
}
