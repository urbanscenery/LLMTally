import { basename, join } from 'node:path';

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
  GROK_AGENT,
  GROK_CURSOR_VERSION,
  GROK_PARSER_VERSION,
  GROK_PROVIDER,
  GROK_UNKNOWN_MODEL,
  GROK_UPDATES_FILE,
} from './constants.ts';
import { GrokPromptBuffer } from './prompt-buffer.ts';
import type { GrokModelUsage } from './records.ts';
import { classifyGrokLine, isGrokCandidateLine } from './records.ts';
import type { GrokSessionMeta } from './session-meta.ts';
import { readGrokSessionMeta } from './session-meta.ts';

const BATCH_MAX_ENTRIES = 2000;

export interface GrokAdapterOptions {
  /** Overrides ~/.grok/sessions; used by tests. */
  readonly rootDirectory?: string;
}

/**
 * Grok Build writes one directory per session under a percent-encoded
 * project directory. Only `updates.jsonl` is append-only and carries
 * usage: `turn_completed` closes each prompt with per-model token counts
 * and an authoritative `costUsdTicks`. The sibling `chat_history.jsonl`
 * holds the same conversation but no usage, and its user records are
 * wrapped in injected `<user_info>` context — so prompts are read from
 * the `user_message_chunk` records here, which are the raw text.
 */
export class GrokAdapter implements SourceAdapter {
  readonly agent = GROK_AGENT;
  readonly parserVersion = GROK_PARSER_VERSION;
  readonly #rootDirectory: string | null;

  constructor(options: GrokAdapterOptions = {}) {
    this.#rootDirectory = options.rootDirectory ?? null;
  }

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery> {
    const root = this.#rootDirectory ?? join(context.homeDirectory, '.grok', 'sessions');
    const discovery = discoverJsonlFiles(this.agent, root);
    return Promise.resolve({
      targets: discovery.targets.filter((target) => basename(target.path) === GROK_UPDATES_FILE),
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
    const meta = readGrokSessionMeta(target.path);
    const buffer = resume.buffer;
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
          warnings.push(line.oversized
            ? lineWarning(this.agent, target.path, line.startOffset, 'oversized_line', 'line exceeds the 32MiB cap; skipped')
            : lineWarning(this.agent, target.path, line.startOffset, 'invalid_utf8', 'line is not valid UTF-8'));
        } else if (line.text.length > 0 && isGrokCandidateLine(line.text)) {
          this.#handleLine(line.text, line.startOffset, target, meta, buffer, entries, warnings);
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
    meta: GrokSessionMeta,
    buffer: GrokPromptBuffer,
    entries: LedgerEntry[],
    warnings: ScanWarning[],
  ): void {
    const record = classifyGrokLine(text);
    switch (record.kind) {
      case 'user_chunk':
        buffer.append({
          promptIndex: record.promptIndex,
          text: record.text,
          modelId: record.modelId,
        });
        return;
      case 'turn_completed': {
        const prompt = buffer.take();
        if (prompt === null) {
          warnings.push(
            lineWarning(
              this.agent,
              target.path,
              startOffset,
              'prompt_unresolved',
              'turn completed with no preceding user message in scan range',
            ),
          );
        }
        const sessionId = record.sessionId ?? meta.sessionId;
        for (const usage of record.usages) {
          entries.push(
            this.#entryFrom(
              usage,
              meta,
              sessionId,
              prompt?.text ?? null,
              promptKeyFor(sessionId, record.promptId),
              naturalIdFor(sessionId, record.promptId, startOffset, usage.model),
              usage.model.length > 0 ? usage.model : (prompt?.modelId ?? GROK_UNKNOWN_MODEL),
              record.tsUtc,
            ),
          );
        }
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
    usage: GrokModelUsage,
    meta: GrokSessionMeta,
    sessionId: string | null,
    promptText: string | null,
    promptKey: string | null,
    naturalId: string,
    model: string,
    tsUtc: number,
  ): LedgerEntry {
    return {
      tsUtc,
      agent: this.agent,
      account: null,
      provider: GROK_PROVIDER,
      model,
      effort: meta.effort,
      promptText,
      promptKey,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      reasoningTokens: usage.reasoningTokens,
      costUsd: usage.costUsd,
      sessionId,
      cwd: meta.cwd,
      naturalId,
      parserVersion: this.parserVersion,
      isSidechain: false,
      parentUuid: null,
    };
  }

  #resolveResume(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
    stats: SourceFileStats,
  ): { startOffset: number; buffer: GrokPromptBuffer; warnings: readonly ScanWarning[] } {
    const fresh = {
      startOffset: 0,
      buffer: new GrokPromptBuffer(),
      warnings: [] as readonly ScanWarning[],
    };
    if (options.fullRescan || state === null) {
      return fresh;
    }
    const reason = jsonlResumeResetReason({
      path: target.path,
      lastOffset: state.lastOffset,
      cursorVersion: state.cursorJson.version,
      expectedCursorVersion: GROK_CURSOR_VERSION,
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
      buffer: GrokPromptBuffer.fromJson(state.cursorJson.pendingPrompt),
      warnings: [],
    };
  }
}

/**
 * prompt_id is minted per prompt, so the same id means the same turn and
 * re-ingesting it is a no-op. The byte offset stands in when a record has
 * no id: a cursor reset replays the same offsets, so the key stays stable.
 */
function naturalIdFor(
  sessionId: string | null,
  promptId: string | null,
  startOffset: number,
  model: string,
): string {
  const turn = promptId ?? `@${startOffset}`;
  return `${sessionId ?? 'unknown'}:${turn}:${model.length > 0 ? model : GROK_UNKNOWN_MODEL}`;
}

/**
 * One prompt bills several usages (one per model), all under the same
 * prompt_id — that id, namespaced by session, is the prompt's identity.
 */
function promptKeyFor(sessionId: string | null, promptId: string | null): string | null {
  if (promptId === null) {
    return null;
  }
  return `${sessionId ?? 'unknown'}:${promptId}`;
}

function buildCursor(
  file: ReturnType<typeof buildFileIdentity>,
  buffer: GrokPromptBuffer,
): JsonObject {
  const pending = buffer.toJson();
  return {
    version: GROK_CURSOR_VERSION,
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
