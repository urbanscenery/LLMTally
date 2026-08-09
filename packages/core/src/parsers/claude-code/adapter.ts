import { join } from 'node:path';

import type { JsonObject } from '../../domain/types.ts';
import type { LedgerEntry } from '../../domain/types.ts';
import { discoverJsonlFiles } from '../../scan/file-discovery.ts';
import { readJsonlLines } from '../../scan/jsonl-reader.ts';
import type { CursorFileIdentity, SourceFileStats } from '../../scan/jsonl-resume.ts';
import {
  buildFileIdentity,
  jsonlResumeResetReason,
  statSourceFile,
} from '../../scan/jsonl-resume.ts';
import type {
  AdapterScanOptions,
  ScanBatch,
  ScanWarning,
  SourceTarget,
  StoredScanState,
} from '../../scan/types.ts';
import type { SourceAdapter, SourceDiscovery, SourceDiscoveryContext } from '../types.ts';
import { buildNaturalId } from './natural-id.ts';
import { PromptTracker } from './prompts.ts';
import {
  CLAUDE_AGENT,
  CLAUDE_PARSER_VERSION,
  CLAUDE_PROVIDER,
  classifyClaudeLine,
  isCandidateLine,
} from './records.ts';

const BATCH_MAX_ENTRIES = 2000;
const CURSOR_VERSION = 1;

export interface ClaudeCodeAdapterOptions {
  /** Overrides ~/.claude/projects; used by tests and doctor tooling. */
  readonly rootDirectory?: string;
}

export class ClaudeCodeAdapter implements SourceAdapter {
  readonly agent = CLAUDE_AGENT;
  readonly parserVersion = CLAUDE_PARSER_VERSION;
  readonly #rootDirectory: string | null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#rootDirectory = options.rootDirectory ?? null;
  }

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery> {
    const root =
      this.#rootDirectory ?? join(context.homeDirectory, '.claude', 'projects');
    return Promise.resolve(discoverJsonlFiles(this.agent, root));
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
    const resume = resolveResume(this.agent, target, state, options, stats);
    const fileIdentity = buildFileIdentity(target.path, stats, ceiling);

    const tracker = resume.tracker;
    let entries: LedgerEntry[] = [];
    let warnings: ScanWarning[] = [...resume.warnings];
    let lastLineEnd = resume.startOffset;

    const makeBatch = (nextOffset: number, tailPending: boolean): ScanBatch => ({
      entries,
      nextOffset,
      nextCursor: buildCursor(fileIdentity, tracker),
      sourceMtime: stats.mtime,
      sourceSize: ceiling,
      tailPending,
      warnings,
    });

    // the finally block closes the reader's file descriptor even when the
    // consumer aborts this generator mid-scan (e.g. a failed batch commit
    // triggers IteratorClose, which would otherwise strand the open fd)
    const iterator = readJsonlLines(target.path, resume.startOffset, ceiling);
    try {
      let step = iterator.next();
      while (!step.done) {
        const line = step.value;
      if (line.invalidUtf8 || line.text === null) {
        warnings.push(lineWarning(this.agent, target.path, line.startOffset, 'invalid_utf8', 'line is not valid UTF-8'));
      } else if (line.text.length > 0 && isCandidateLine(line.text)) {
        const classified = classifyClaudeLine(line.text);
        if (classified.kind === 'user') {
          tracker.recordUserPrompt(classified);
        } else if (classified.kind === 'malformed') {
          warnings.push(lineWarning(this.agent, target.path, line.startOffset, 'malformed_json', classified.reason));
        } else if (classified.kind === 'invalid') {
          warnings.push(lineWarning(this.agent, target.path, line.startOffset, 'invalid_record', classified.reason));
        } else if (classified.kind === 'usage') {
          const naturalId = buildNaturalId(classified, {
            fingerprint: target.fingerprint,
            path: target.path,
            lineStartOffset: line.startOffset,
          });
          if (naturalId === null) {
            warnings.push(
              lineWarning(this.agent, target.path, line.startOffset, 'invalid_record', 'usage record has neither uuid nor requestId'),
            );
          } else {
            const promptText = tracker.resolvePrompt(classified);
            if (promptText === null) {
              warnings.push(
                lineWarning(this.agent, target.path, line.startOffset, 'prompt_unresolved', 'no eligible prompt found for usage record'),
              );
            }
            entries.push({
              tsUtc: classified.tsUtc,
              agent: this.agent,
              account: null,
              provider: CLAUDE_PROVIDER,
              model: classified.model,
              effort: classified.effort,
              promptText,
              inputTokens: classified.inputTokens,
              outputTokens: classified.outputTokens,
              cacheWrite: classified.cacheWrite,
              cacheRead: classified.cacheRead,
              reasoningTokens: 0,
              costUsd: null,
              sessionId: classified.sessionId,
              cwd: classified.cwd,
              naturalId,
              parserVersion: this.parserVersion,
              isSidechain: classified.isSidechain,
              parentUuid: classified.parentUuid,
            });
          }
        }
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
}

interface ResumeDecision {
  readonly startOffset: number;
  readonly tracker: PromptTracker;
  readonly warnings: readonly ScanWarning[];
}

function resolveResume(
  agent: string,
  target: SourceTarget,
  state: StoredScanState | null,
  options: AdapterScanOptions,
  stats: SourceFileStats,
): ResumeDecision {
  const fresh: ResumeDecision = { startOffset: 0, tracker: new PromptTracker(), warnings: [] };
  if (options.fullRescan || state === null) {
    return fresh;
  }
  const reason = jsonlResumeResetReason({
    path: target.path,
    lastOffset: state.lastOffset,
    cursorVersion: state.cursorJson.version,
    expectedCursorVersion: CURSOR_VERSION,
    cursorFile: state.cursorJson.file,
    stats,
  });
  if (reason !== null) {
    return {
      ...fresh,
      warnings: [
        {
          code: 'cursor_reset',
          agent,
          path: target.path,
          offset: null,
          message: `cursor reset, rescanning from start: ${reason}`,
          recoverable: true,
        },
      ],
    };
  }
  const cursor = state.cursorJson;
  return {
    startOffset: Math.min(state.lastOffset, stats.size),
    tracker: PromptTracker.fromJson(cursor.pendingPrompts),
    warnings: [],
  };
}

function buildCursor(file: CursorFileIdentity, tracker: PromptTracker): JsonObject {
  return {
    version: CURSOR_VERSION,
    file: { ...file },
    pendingPrompts: tracker.toJson(),
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
