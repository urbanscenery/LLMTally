import { asObject, asString, asTokenCount, parseUtcTimestamp } from '../shared.ts';

export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface CodexSessionMetaRecord {
  readonly kind: 'session_meta';
  readonly rolloutId: string;
  readonly sessionId: string | null;
  readonly modelProvider: string | null;
  readonly cwd: string | null;
  readonly isSidechain: boolean;
  readonly parentThreadId: string | null;
}

export interface CodexTurnContextRecord {
  readonly kind: 'turn_context';
  readonly turnId: string;
  readonly model: string;
  readonly effort: string | null;
  readonly cwd: string | null;
}

export interface CodexUserMessageRecord {
  readonly kind: 'user';
  /** Raw input_text blocks; injected-block filtering happens in prompts.ts. */
  readonly rawTexts: readonly string[];
}

export interface CodexTokenCountRecord {
  readonly kind: 'token_count';
  readonly tsUtc: number;
  readonly last: CodexTokenUsage;
  readonly total: CodexTokenUsage;
}

export interface CodexSkippedRecord {
  readonly kind: 'skipped';
}

export interface CodexMalformedRecord {
  readonly kind: 'malformed';
  readonly reason: string;
}

export interface CodexInvalidRecord {
  readonly kind: 'invalid';
  readonly reason: string;
}

export type ClassifiedCodexLine =
  | CodexSessionMetaRecord
  | CodexTurnContextRecord
  | CodexUserMessageRecord
  | CodexTokenCountRecord
  | CodexSkippedRecord
  | CodexMalformedRecord
  | CodexInvalidRecord;

const SKIPPED: CodexSkippedRecord = { kind: 'skipped' };

export function isCodexCandidateLine(line: string): boolean {
  return (
    line.includes('"session_meta"') ||
    line.includes('"turn_context"') ||
    line.includes('"token_count"') ||
    line.includes('"response_item"')
  );
}

export function classifyCodexLine(line: string): ClassifiedCodexLine {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // engine parse errors can quote raw source tokens — never forward them
    return { kind: 'malformed', reason: 'line is not parseable as JSON' };
  }
  const raw = asObject(record);
  if (raw === null) {
    return { kind: 'malformed', reason: 'line is not a JSON object' };
  }
  const payload = asObject(raw.payload);
  if (payload === null) {
    return SKIPPED;
  }
  switch (raw.type) {
    case 'session_meta':
      return classifySessionMeta(payload);
    case 'turn_context':
      return classifyTurnContext(payload);
    case 'event_msg':
      return payload.type === 'token_count' ? classifyTokenCount(raw, payload) : SKIPPED;
    case 'response_item':
      return classifyResponseItem(payload);
    default:
      return SKIPPED;
  }
}

function classifySessionMeta(
  payload: Record<string, unknown>,
): CodexSessionMetaRecord | CodexInvalidRecord {
  const rolloutId = asString(payload.id);
  if (rolloutId === null || rolloutId.length === 0) {
    return { kind: 'invalid', reason: 'session_meta has no rollout id' };
  }
  const source = asObject(payload.source);
  return {
    kind: 'session_meta',
    rolloutId,
    sessionId: asString(payload.session_id),
    modelProvider: asString(payload.model_provider),
    cwd: asString(payload.cwd),
    isSidechain: source !== null && source.subagent !== undefined,
    parentThreadId: asString(payload.parent_thread_id),
  };
}

function classifyTurnContext(
  payload: Record<string, unknown>,
): CodexTurnContextRecord | CodexInvalidRecord {
  const turnId = asString(payload.turn_id);
  const model = asString(payload.model);
  if (turnId === null || turnId.length === 0 || model === null || model.length === 0) {
    return { kind: 'invalid', reason: 'turn_context is missing turn_id or model' };
  }
  return {
    kind: 'turn_context',
    turnId,
    model,
    effort: asString(payload.effort),
    cwd: asString(payload.cwd),
  };
}

function classifyTokenCount(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): CodexTokenCountRecord | CodexSkippedRecord | CodexInvalidRecord {
  const info = asObject(payload.info);
  if (info === null) {
    // rate-limit-only snapshot: carries no usage and must not create rows
    return SKIPPED;
  }
  const tsUtc = parseUtcTimestamp(raw.timestamp);
  if (tsUtc === null) {
    return { kind: 'invalid', reason: 'token_count has no valid UTC timestamp' };
  }
  const last = asUsage(info.last_token_usage);
  const total = asUsage(info.total_token_usage);
  if (last === null || total === null) {
    return { kind: 'invalid', reason: 'token_count usage fields are not non-negative integers' };
  }
  return { kind: 'token_count', tsUtc, last, total };
}

function classifyResponseItem(
  payload: Record<string, unknown>,
): CodexUserMessageRecord | CodexSkippedRecord {
  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return SKIPPED;
  }
  const rawTexts = payload.content
    .map((block) => asObject(block))
    .filter((block): block is Record<string, unknown> => block !== null)
    .filter((block) => block.type === 'input_text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  if (rawTexts.length === 0) {
    return SKIPPED;
  }
  return { kind: 'user', rawTexts };
}

function asUsage(value: unknown): CodexTokenUsage | null {
  const usage = asObject(value);
  if (usage === null) {
    return null;
  }
  const inputTokens = asTokenCount(usage.input_tokens);
  const cachedInputTokens = asTokenCount(usage.cached_input_tokens);
  const cacheWriteInputTokens = asTokenCount(usage.cache_write_input_tokens);
  const outputTokens = asTokenCount(usage.output_tokens);
  const reasoningOutputTokens = asTokenCount(usage.reasoning_output_tokens);
  const totalTokens = asTokenCount(usage.total_tokens);
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}
