import { asObject, asString, asTokenCount, parseUtcTimestamp } from '../shared.ts';
import { CURSOR_CLI_UNKNOWN_MODEL, CURSOR_NATIVE_MODEL } from './constants.ts';

const MILLISECONDS_PER_SECOND = 1000;
const EPOCH_SECONDS_MIN = 1_000_000_000;
const EPOCH_SECONDS_MAX = 4_000_000_000;

export interface CursorCliUsage {
  readonly sessionId: string | null;
  readonly tsUtc: number;
  readonly model: string;
  readonly effort: string | null;
  readonly requestId: string | null;
  readonly promptId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoningTokens: number;
  readonly isSidechain: boolean;
}

export type CursorCliRecord =
  | {
      readonly kind: 'user';
      readonly sessionId: string | null;
      readonly text: string;
      readonly promptKey: string | null;
    }
  | { readonly kind: 'usage'; readonly usage: CursorCliUsage }
  | {
      readonly kind: 'meta';
      readonly cwd: string | null;
      readonly sessionId: string | null;
      readonly model: string | null;
    }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Cheap prefilter: most transcript lines are tool payloads. A line that
 * happens to mention these words only costs a parse that then skips.
 */
export function isCursorCliCandidateLine(text: string): boolean {
  return (
    text.includes('"usage"') ||
    text.includes('"type":"user"') ||
    text.includes('"type": "user"') ||
    text.includes('"type":"result"') ||
    text.includes('"type": "result"')
  );
}

export function classifyCursorCliLine(text: string, fileMtimeUtc: number | null): CursorCliRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: 'malformed', reason: error instanceof Error ? error.message : String(error) };
  }
  const root = asObject(parsed);
  if (root === null) {
    return { kind: 'skipped' };
  }
  const type = asString(root.type);
  if (type === 'user') {
    return userRecord(root);
  }
  if (type === 'system' && asString(root.subtype) === 'init') {
    return {
      kind: 'meta',
      cwd: asString(root.cwd),
      sessionId: sessionIdOf(root),
      model: asString(root.model),
    };
  }
  if (type === 'assistant' || type === 'result') {
    return usageRecord(root, fileMtimeUtc);
  }
  return { kind: 'skipped' };
}

/**
 * Native Cursor models bill the Cursor Models pool (`provider: cursor`).
 * Third-party names keep their vendor so billingNature stays unknown.
 */
export function cursorCliProviderFromModel(model: string): string {
  if (CURSOR_NATIVE_MODEL.test(model)) {
    return 'cursor';
  }
  const lower = model.toLowerCase();
  if (
    lower.includes('claude') ||
    lower.includes('sonnet') ||
    lower.includes('opus') ||
    lower.includes('haiku') ||
    lower.includes('fable')
  ) {
    return 'anthropic';
  }
  if (lower.startsWith('gpt-') || /^o[0-9]/.test(lower)) {
    return 'openai';
  }
  if (lower.includes('gemini')) {
    return 'google';
  }
  return 'other';
}

export function usageTokenSum(usage: CursorCliUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheRead + usage.cacheWrite;
}

function userRecord(root: Record<string, unknown>): CursorCliRecord {
  const text = extractUserText(root);
  if (text === null) {
    return { kind: 'skipped' };
  }
  const sessionId = sessionIdOf(root);
  const eventId = asString(root.uuid ?? root.id ?? null);
  return {
    kind: 'user',
    sessionId,
    text,
    promptKey: eventId ?? (sessionId === null ? null : `${sessionId}:user`),
  };
}

function usageRecord(
  root: Record<string, unknown>,
  fileMtimeUtc: number | null,
): CursorCliRecord {
  const usageObject = findUsageObject(root);
  if (usageObject === null) {
    return { kind: 'skipped' };
  }
  const tokens = readTokenFields(usageObject);
  if (tokens === null) {
    return { kind: 'invalid', reason: 'usage object has non-integer token counts' };
  }
  const tsUtc = eventTimestamp(root, fileMtimeUtc);
  if (tsUtc === null) {
    return { kind: 'invalid', reason: 'usage event carries no usable timestamp' };
  }
  const message = asObject(root.message);
  const model =
    asString(root.model_id ?? root.model ?? message?.model ?? null) ?? CURSOR_CLI_UNKNOWN_MODEL;
  return {
    kind: 'usage',
    usage: {
      sessionId: sessionIdOf(root),
      tsUtc,
      model,
      effort: effortOf(root, message),
      requestId: asString(root.request_id ?? root.requestId ?? null),
      promptId: asString(root.prompt_id ?? root.promptId ?? null),
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      reasoningTokens: tokens.reasoningTokens,
      isSidechain: root.isSidechain === true || root.is_sidechain === true,
    },
  };
}

function findUsageObject(root: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asObject(root.usage);
  if (direct !== null) {
    return direct;
  }
  const message = asObject(root.message);
  return message === null ? null : asObject(message.usage);
}

function readTokenFields(usage: Record<string, unknown>): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoningTokens: number;
} | null {
  const inputTokens = asTokenCount(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = asTokenCount(usage.outputTokens ?? usage.output_tokens);
  const cacheRead = asTokenCount(
    usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens,
  );
  const cacheWrite = asTokenCount(
    usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens,
  );
  const reasoningTokens = asTokenCount(
    usage.reasoningTokens ?? usage.reasoning_tokens ?? undefined,
  );
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheRead === null ||
    cacheWrite === null ||
    reasoningTokens === null
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cacheRead, cacheWrite, reasoningTokens };
}

function extractUserText(root: Record<string, unknown>): string | null {
  const message = asObject(root.message);
  const raw = message?.content ?? root.content ?? root.text;
  const text = contentText(raw);
  if (text === null || text.length === 0) {
    return null;
  }
  // same spirit as Claude's injected-context filter: skip system wrappers
  if (text.startsWith('<')) {
    return null;
  }
  return text;
}

function contentText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    const object = asObject(value);
    return object === null ? null : asString(object.text);
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const block = asObject(item);
    const text = block === null ? null : asString(block.text);
    if (text !== null && (block?.type === 'text' || block?.type === undefined)) {
      parts.push(text);
    }
  }
  return parts.length === 0 ? null : parts.join('');
}

function sessionIdOf(root: Record<string, unknown>): string | null {
  return asString(root.session_id ?? root.sessionId ?? null);
}

function effortOf(
  root: Record<string, unknown>,
  message: Record<string, unknown> | null,
): string | null {
  const direct = asString(root.effort ?? message?.effort ?? null);
  if (direct !== null) {
    return direct;
  }
  const params = root.model_params ?? message?.model_params;
  if (!Array.isArray(params)) {
    return null;
  }
  for (const item of params) {
    const param = asObject(item);
    if (param !== null && asString(param.id) === 'effort') {
      return asString(param.value);
    }
  }
  return null;
}

function eventTimestamp(root: Record<string, unknown>, fileMtimeUtc: number | null): number | null {
  const iso = parseUtcTimestamp(root.timestamp);
  if (iso !== null) {
    return iso;
  }
  const numeric = root.timestamp_ms ?? root.timestamp;
  if (typeof numeric === 'number' && Number.isFinite(numeric)) {
    const seconds =
      numeric > EPOCH_SECONDS_MAX
        ? Math.floor(numeric / MILLISECONDS_PER_SECOND)
        : Math.floor(numeric);
    if (seconds >= EPOCH_SECONDS_MIN && seconds <= EPOCH_SECONDS_MAX) {
      return seconds;
    }
  }
  return fileMtimeUtc;
}
