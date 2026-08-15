import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
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
import { asObject, asString, asTokenCount, isNonNegativeInteger } from '../shared.ts';

export const CLINE_AGENT = 'cline';
export const CLINE_PARSER_VERSION = 2;
const CLINE_CURSOR_VERSION = 1;
const MESSAGES_SUFFIX = '.messages.json';
const MILLISECONDS_PER_SECOND = 1000;
/**
 * A session file must be parsed as one JSON document, so its size IS
 * the parse's peak memory (audit D-04). Files past this cap are skipped
 * with a warning instead of taking the whole scan down; the largest
 * session measured in the wild is a few MB, so 64MB is pathological.
 */
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export interface ClineAdapterOptions {
  /** Overrides ~/.cline/data/sessions; used by tests. */
  readonly rootDirectory?: string;
}

/**
 * Cline rewrites the whole messages file on every update, so there is no
 * byte offset to resume from: any fingerprint change triggers a full
 * reparse and the message-id natural key deduplicates. Measured trap:
 * most "user" messages are tool_result payloads — only real text blocks
 * may become the pending prompt.
 */
export class ClineAdapter implements SourceAdapter {
  readonly agent = CLINE_AGENT;
  readonly parserVersion = CLINE_PARSER_VERSION;
  readonly #rootDirectory: string | null;

  constructor(options: ClineAdapterOptions = {}) {
    this.#rootDirectory = options.rootDirectory ?? null;
  }

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery> {
    const root =
      this.#rootDirectory ?? join(context.homeDirectory, '.cline', 'data', 'sessions');
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return Promise.resolve({
        targets: [],
        warnings: [
          warning(
            this.agent,
            root,
            code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'source_missing',
            `cline session root unavailable: ${describe(error)}`,
          ),
        ],
      });
    }
    const targets: SourceTarget[] = [];
    for (const dir of sessionDirs.sort()) {
      const path = join(root, dir, `${dir}${MESSAGES_SUFFIX}`);
      try {
        if (statSync(path).isFile()) {
          targets.push({ agent: this.agent, path, kind: 'json', fingerprint: null });
        }
      } catch {
        // a session directory without a messages file is not an error
      }
    }
    return Promise.resolve({ targets, warnings: [] });
  }

  async *scan(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
  ): AsyncIterable<ScanBatch> {
    let before: Stats;
    try {
      before = statSync(target.path);
    } catch (error) {
      yield emptyBatch([
        warning(this.agent, target.path, 'source_missing', `session file disappeared: ${describe(error)}`),
      ]);
      return;
    }

    if (!options.fullRescan && state !== null && isUnchanged(state, before)) {
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

    if (before.size > MAX_SESSION_FILE_BYTES) {
      yield emptyBatch([
        warning(
          this.agent,
          target.path,
          'runtime',
          `session file is ${Math.round(before.size / 1048576)}MB (cap ${MAX_SESSION_FILE_BYTES / 1048576}MB); skipped to bound scan memory`,
        ),
      ]);
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(target.path, 'utf8');
    } catch (error) {
      yield emptyBatch([
        warning(this.agent, target.path, 'runtime', `cannot read session file: ${describe(error)}`),
      ]);
      return;
    }
    // a rewrite racing our read yields a possibly-torn snapshot: rows
    // from it could pin wrong prompt/cost values forever (natural-id
    // dedup never corrects them), so ingest NOTHING and retry next cycle
    const after = statSync(target.path);
    const torn = after.mtimeMs !== before.mtimeMs || after.size !== before.size;
    if (torn) {
      yield emptyBatch([
        warning(this.agent, target.path, 'runtime', 'session file changed during read; retrying next scan'),
      ]);
      return;
    }

    const meta = readMeta(target.path);
    const parsed = parseSession(raw, this.agent, target.path, meta);
    yield {
      entries: parsed.malformed ? [] : parsed.entries,
      nextOffset: parsed.malformed ? null : 0,
      nextCursor: parsed.malformed ? {} : cursorFor(before, meta.stats),
      sourceMtime: Math.floor(before.mtimeMs),
      sourceSize: before.size,
      tailPending: false,
      warnings: parsed.warnings,
    };
  }
}

function isUnchanged(state: StoredScanState, stats: Stats): boolean {
  const cursor = state.cursorJson;
  if (
    cursor.version !== CLINE_CURSOR_VERSION ||
    !isNonNegativeInteger(cursor.device) ||
    cursor.device !== stats.dev ||
    cursor.inode !== stats.ino ||
    state.mtime !== Math.floor(stats.mtimeMs) ||
    state.size !== stats.size
  ) {
    return false;
  }
  // the sibling meta file can appear or change later (cwd/model) — a
  // change there must also trigger a reparse
  const meta = statMetaSafe(state.path);
  return cursor.metaMtime === meta.mtime && cursor.metaSize === meta.size;
}

function cursorFor(stats: Stats, metaStats: { mtime: number | null; size: number | null }): JsonObject {
  return {
    version: CLINE_CURSOR_VERSION,
    device: stats.dev,
    inode: stats.ino,
    metaMtime: metaStats.mtime,
    metaSize: metaStats.size,
  };
}

interface ClineMeta {
  readonly cwd: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly stats: { readonly mtime: number | null; readonly size: number | null };
}

function statMetaSafe(messagesPath: string): { mtime: number | null; size: number | null } {
  try {
    const stats = statSync(messagesPath.replace(MESSAGES_SUFFIX, '.json'));
    return { mtime: Math.floor(stats.mtimeMs), size: stats.size };
  } catch {
    return { mtime: null, size: null };
  }
}

function readMeta(messagesPath: string): ClineMeta {
  const metaPath = messagesPath.replace(MESSAGES_SUFFIX, '.json');
  const stats = statMetaSafe(messagesPath);
  try {
    const meta = asObject(JSON.parse(readFileSync(metaPath, 'utf8')));
    return {
      cwd: meta === null ? null : asString(meta.cwd),
      model: meta === null ? null : asString(meta.model),
      provider: meta === null ? null : asString(meta.provider),
      stats,
    };
  } catch {
    return { cwd: null, model: null, provider: null, stats };
  }
}

function parseSession(
  raw: string,
  agent: string,
  path: string,
  meta: ClineMeta,
): { entries: LedgerEntry[]; warnings: ScanWarning[]; malformed: boolean } {
  const warnings: ScanWarning[] = [];
  let document: Record<string, unknown> | null;
  try {
    document = asObject(JSON.parse(raw));
  } catch {
    document = null;
  }
  if (document === null || !Array.isArray(document.messages)) {
    warnings.push(warning(agent, path, 'malformed_json', 'session file is not a valid messages document'));
    return { entries: [], warnings, malformed: true };
  }
  const sessionId = asString(document.sessionId);

  const entries: LedgerEntry[] = [];
  let pendingPrompt: PendingClinePrompt | null = null;
  let skippedInvalid = 0;
  for (const item of document.messages) {
    const message = asObject(item);
    if (message === null) {
      continue;
    }
    if (message.role === 'user') {
      const text = extractUserText(message.content);
      if (text !== null) {
        // the user message id (falling back to its position) is the
        // prompt identity every following assistant step shares
        pendingPrompt = { text, key: promptKeyFor(sessionId, message, entries.length) };
      }
      continue;
    }
    if (message.role !== 'assistant') {
      continue;
    }
    const metrics = asObject(message.metrics);
    if (metrics === null) {
      continue;
    }
    const entry = toEntry(message, metrics, meta, sessionId, pendingPrompt);
    if (entry === null) {
      skippedInvalid += 1;
    } else {
      entries.push(entry);
    }
  }
  if (skippedInvalid > 0) {
    warnings.push(
      warning(agent, path, 'invalid_record', `${skippedInvalid} assistant metrics rows were invalid`),
    );
  }
  return { entries, warnings, malformed: false };
}

/** Only genuine text reaches the prompt; tool_result payloads never do. */
function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const texts = content
    .map((block) => asObject(block))
    .filter((block): block is Record<string, unknown> => block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .filter((text) => text.trim().length > 0);
  return texts.length > 0 ? texts.join('\n') : null;
}

interface PendingClinePrompt {
  readonly text: string;
  readonly key: string;
}

function promptKeyFor(
  sessionId: string | null,
  userMessage: Record<string, unknown>,
  ordinal: number,
): string {
  const messageId = asString(userMessage.id);
  const local = messageId !== null && messageId.trim().length > 0 ? messageId : `#${ordinal}`;
  return `${sessionId ?? 'unknown'}:${local}`;
}

function toEntry(
  message: Record<string, unknown>,
  metrics: Record<string, unknown>,
  meta: ClineMeta,
  sessionId: string | null,
  prompt: PendingClinePrompt | null,
): LedgerEntry | null {
  const naturalId = asString(message.id);
  const ts = message.ts;
  if (
    naturalId === null ||
    naturalId.trim().length === 0 ||
    typeof ts !== 'number' ||
    !Number.isFinite(ts) ||
    ts <= 0
  ) {
    return null;
  }
  const inputTokens = asTokenCount(metrics.inputTokens);
  const outputTokens = asTokenCount(metrics.outputTokens);
  const cacheRead = asTokenCount(metrics.cacheReadTokens);
  const cacheWrite = asTokenCount(metrics.cacheWriteTokens);
  if (inputTokens === null || outputTokens === null || cacheRead === null || cacheWrite === null) {
    return null;
  }
  const modelInfo = asObject(message.modelInfo);
  const cost = metrics.cost;
  return {
    tsUtc: Math.floor(ts / MILLISECONDS_PER_SECOND),
    agent: CLINE_AGENT,
    account: null,
    provider: (modelInfo === null ? null : asString(modelInfo.provider)) ?? meta.provider,
    model: (modelInfo === null ? null : asString(modelInfo.id)) ?? meta.model ?? 'unknown',
    effort: null,
    promptText: prompt?.text ?? null,
    promptKey: prompt?.key ?? null,
    inputTokens,
    outputTokens,
    cacheWrite,
    cacheRead,
    reasoningTokens: 0,
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    sessionId,
    cwd: meta.cwd,
    naturalId,
    parserVersion: CLINE_PARSER_VERSION,
    isSidechain: false,
    parentUuid: null,
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
