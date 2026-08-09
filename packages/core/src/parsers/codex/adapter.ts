import { basename, join } from 'node:path';

import type { JsonObject, LedgerEntry } from '../../domain/types.ts';
import { discoverJsonlFiles } from '../../scan/file-discovery.ts';
import { readJsonlLines } from '../../scan/jsonl-reader.ts';
import type { SourceFileStats } from '../../scan/jsonl-resume.ts';
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
import { asString } from '../shared.ts';
import {
  CODEX_AGENT,
  CODEX_CURSOR_VERSION,
  CODEX_PARSER_VERSION,
  CODEX_PROVIDER_FALLBACK,
} from './constants.ts';
import { buildCodexNaturalId, usageDigest } from './natural-id.ts';
import { extractCodexPrompt } from './prompts.ts';
import type { CodexSessionMetaRecord, CodexTokenCountRecord } from './records.ts';
import { classifyCodexLine, isCodexCandidateLine } from './records.ts';
import { CodexTurnTracker } from './turn-state.ts';

const BATCH_MAX_ENTRIES = 2000;
const ROLLOUT_FILE_PREFIX = 'rollout-';
const UNKNOWN_MODEL = 'unknown';

interface RolloutMeta {
  rolloutId: string | null;
  sessionId: string | null;
  modelProvider: string | null;
  cwd: string | null;
  isSidechain: boolean;
  parentThreadId: string | null;
}

export interface CodexAdapterOptions {
  /** Overrides ~/.codex/sessions; used by tests. */
  readonly rootDirectory?: string;
}

export class CodexAdapter implements SourceAdapter {
  readonly agent = CODEX_AGENT;
  readonly parserVersion = CODEX_PARSER_VERSION;
  readonly #rootDirectory: string | null;

  constructor(options: CodexAdapterOptions = {}) {
    this.#rootDirectory = options.rootDirectory ?? null;
  }

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery> {
    const root = this.#rootDirectory ?? join(context.homeDirectory, '.codex', 'sessions');
    const discovery = discoverJsonlFiles(this.agent, root);
    return Promise.resolve({
      targets: discovery.targets.filter((target) =>
        basename(target.path).startsWith(ROLLOUT_FILE_PREFIX),
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

    const meta = resume.meta;
    const tracker = resume.tracker;
    let entries: LedgerEntry[] = [];
    let warnings: ScanWarning[] = [...resume.warnings];

    const makeBatch = (nextOffset: number, tailPending: boolean): ScanBatch => ({
      entries,
      nextOffset,
      nextCursor: buildCursor(fileIdentity, meta, tracker),
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
          warnings.push(lineWarning(this.agent, target.path, line.startOffset, 'invalid_utf8', 'line is not valid UTF-8'));
        } else if (line.text.length > 0 && isCodexCandidateLine(line.text)) {
          this.#handleLine(line.text, line.startOffset, target, meta, tracker, entries, warnings);
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
    meta: RolloutMeta,
    tracker: CodexTurnTracker,
    entries: LedgerEntry[],
    warnings: ScanWarning[],
  ): void {
    const classified = classifyCodexLine(text);
    switch (classified.kind) {
      case 'session_meta':
        // only the first session_meta is the physical rollout identity;
        // later ones are subagent replays and must not overwrite it
        if (meta.rolloutId === null) {
          applySessionMeta(meta, classified);
        }
        return;
      case 'turn_context':
        tracker.startTurn(classified);
        return;
      case 'user': {
        const extraction = extractCodexPrompt(classified.rawTexts);
        if (extraction.hasUnterminatedBlock) {
          warnings.push(
            lineWarning(this.agent, target.path, startOffset, 'invalid_record', 'unterminated injected block kept inside prompt text'),
          );
        }
        if (extraction.promptText !== null) {
          tracker.recordUserPrompt(extraction.promptText);
        }
        return;
      }
      case 'token_count':
        this.#handleUsage(classified, startOffset, target, meta, tracker, entries, warnings);
        return;
      case 'malformed':
        warnings.push(lineWarning(this.agent, target.path, startOffset, 'malformed_json', classified.reason));
        return;
      case 'invalid':
        warnings.push(lineWarning(this.agent, target.path, startOffset, 'invalid_record', classified.reason));
        return;
      case 'skipped':
        return;
    }
  }

  #handleUsage(
    record: CodexTokenCountRecord,
    startOffset: number,
    target: SourceTarget,
    meta: RolloutMeta,
    tracker: CodexTurnTracker,
    entries: LedgerEntry[],
    warnings: ScanWarning[],
  ): void {
    const decision = tracker.acceptUsage(record);
    if (decision.kind === 'duplicate') {
      return;
    }
    if (decision.kind === 'no_turn') {
      const naturalId = buildCodexNaturalId({
        turnId: null,
        usageDigest: null,
        rolloutId: meta.rolloutId,
        lineStartOffset: startOffset,
      });
      if (naturalId === null) {
        warnings.push(
          lineWarning(this.agent, target.path, startOffset, 'invalid_record', 'usage event has neither turn context nor rollout identity'),
        );
        return;
      }
      warnings.push(
        lineWarning(this.agent, target.path, startOffset, 'prompt_unresolved', 'usage event without turn context recorded with unknown model'),
      );
      entries.push(this.#entryFrom(record, meta, naturalId, UNKNOWN_MODEL, null, null, meta.cwd));
      return;
    }
    const turn = decision.turn;
    const naturalId = buildCodexNaturalId({
      turnId: turn.turnId,
      usageDigest: usageDigest(record.last, record.total),
      rolloutId: meta.rolloutId,
      lineStartOffset: startOffset,
    });
    if (naturalId === null) {
      return;
    }
    entries.push(
      this.#entryFrom(record, meta, naturalId, turn.model, turn.effort, turn.promptText, turn.cwd ?? meta.cwd),
    );
  }

  #entryFrom(
    record: CodexTokenCountRecord,
    meta: RolloutMeta,
    naturalId: string,
    model: string,
    effort: string | null,
    promptText: string | null,
    cwd: string | null,
  ): LedgerEntry {
    return {
      tsUtc: record.tsUtc,
      agent: this.agent,
      account: null,
      provider: meta.modelProvider ?? CODEX_PROVIDER_FALLBACK,
      model,
      effort,
      promptText,
      inputTokens: record.last.inputTokens,
      outputTokens: record.last.outputTokens,
      cacheWrite: record.last.cacheWriteInputTokens,
      cacheRead: record.last.cachedInputTokens,
      reasoningTokens: record.last.reasoningOutputTokens,
      costUsd: null,
      sessionId: meta.sessionId ?? meta.rolloutId,
      cwd,
      naturalId,
      parserVersion: this.parserVersion,
      isSidechain: meta.isSidechain,
      parentUuid: meta.parentThreadId,
    };
  }

  #resolveResume(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
    stats: SourceFileStats,
  ): {
    startOffset: number;
    meta: RolloutMeta;
    tracker: CodexTurnTracker;
    warnings: readonly ScanWarning[];
  } {
    const fresh = {
      startOffset: 0,
      meta: emptyMeta(),
      tracker: new CodexTurnTracker(),
      warnings: [] as readonly ScanWarning[],
    };
    if (options.fullRescan || state === null) {
      return fresh;
    }
    const reason = jsonlResumeResetReason({
      path: target.path,
      lastOffset: state.lastOffset,
      cursorVersion: state.cursorJson.version,
      expectedCursorVersion: CODEX_CURSOR_VERSION,
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
    const cursor = state.cursorJson;
    return {
      startOffset: Math.min(state.lastOffset, stats.size),
      meta: {
        rolloutId: asString(cursor.rolloutId),
        sessionId: asString(cursor.sessionId),
        modelProvider: asString(cursor.modelProvider),
        cwd: asString(cursor.cwd),
        isSidechain: cursor.isSidechain === true,
        parentThreadId: asString(cursor.parentThreadId),
      },
      tracker: CodexTurnTracker.fromJson(cursor.pendingPrompt, cursor.activeTurn),
      warnings: [],
    };
  }
}

function applySessionMeta(meta: RolloutMeta, record: CodexSessionMetaRecord): void {
  meta.rolloutId = record.rolloutId;
  meta.sessionId = record.sessionId;
  meta.modelProvider = record.modelProvider;
  meta.cwd = record.cwd;
  meta.isSidechain = record.isSidechain;
  meta.parentThreadId = record.parentThreadId;
}

function emptyMeta(): RolloutMeta {
  return {
    rolloutId: null,
    sessionId: null,
    modelProvider: null,
    cwd: null,
    isSidechain: false,
    parentThreadId: null,
  };
}

function buildCursor(
  file: ReturnType<typeof buildFileIdentity>,
  meta: RolloutMeta,
  tracker: CodexTurnTracker,
): JsonObject {
  const trackerState = tracker.toJson();
  return {
    version: CODEX_CURSOR_VERSION,
    file: { ...file },
    rolloutId: meta.rolloutId,
    sessionId: meta.sessionId,
    modelProvider: meta.modelProvider,
    cwd: meta.cwd,
    isSidechain: meta.isSidechain,
    parentThreadId: meta.parentThreadId,
    pendingPrompt: trackerState.pendingPrompt,
    activeTurn: trackerState.activeTurn,
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
