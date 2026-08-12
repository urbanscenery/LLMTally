import { asObject, asString, asTokenCount } from '../shared.ts';
import { GROK_COST_TICKS_PER_USD } from './constants.ts';

const MILLISECONDS_PER_SECOND = 1000;
const EPOCH_SECONDS_MIN = 1_000_000_000;
const EPOCH_SECONDS_MAX = 4_000_000_000;

/** One model's slice of a turn. Grok bills per model inside one turn. */
export interface GrokModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoningTokens: number;
  readonly costUsd: number | null;
}

export type GrokRecord =
  | {
      readonly kind: 'user_chunk';
      readonly sessionId: string | null;
      readonly promptIndex: number | null;
      readonly text: string;
      readonly modelId: string | null;
    }
  | {
      readonly kind: 'turn_completed';
      readonly sessionId: string | null;
      readonly tsUtc: number;
      readonly promptId: string | null;
      readonly usages: readonly GrokModelUsage[];
    }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Cheap prefilter: tool_call_update lines carry whole file bodies and are
 * the bulk of the stream, so most lines must never reach JSON.parse. A
 * file body that happens to contain one of these words only costs a parse
 * that then classifies as skipped.
 */
export function isGrokCandidateLine(text: string): boolean {
  return text.includes('"user_message_chunk"') || text.includes('"turn_completed"');
}

export function classifyGrokLine(text: string): GrokRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: 'malformed', reason: error instanceof Error ? error.message : String(error) };
  }
  const root = asObject(parsed);
  const params = root === null ? null : asObject(root.params);
  const update = params === null ? null : asObject(params.update);
  if (update === null) {
    return { kind: 'skipped' };
  }
  const sessionId = asString(params?.sessionId ?? null);
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return userChunk(update, sessionId);
    case 'turn_completed':
      return turnCompleted(update, params, root, sessionId);
    default:
      return { kind: 'skipped' };
  }
}

function userChunk(update: Record<string, unknown>, sessionId: string | null): GrokRecord {
  const content = asObject(update.content);
  const text = content === null || content.type !== 'text' ? null : asString(content.text);
  if (text === null) {
    return { kind: 'skipped' };
  }
  const meta = asObject(update._meta);
  const rawIndex = meta?.promptIndex;
  return {
    kind: 'user_chunk',
    sessionId,
    promptIndex:
      typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : null,
    text,
    modelId: asString(meta?.modelId ?? null),
  };
}

function turnCompleted(
  update: Record<string, unknown>,
  params: Record<string, unknown> | null,
  root: Record<string, unknown> | null,
  sessionId: string | null,
): GrokRecord {
  const usage = asObject(update.usage);
  if (usage === null) {
    return { kind: 'invalid', reason: 'turn_completed carries no usage object' };
  }
  const tsUtc = turnTimestamp(params, root);
  if (tsUtc === null) {
    return { kind: 'invalid', reason: 'turn_completed carries no usable timestamp' };
  }
  const usages = modelUsages(usage);
  if (usages.length === 0) {
    return { kind: 'invalid', reason: 'turn_completed usage has no valid token counts' };
  }
  return { kind: 'turn_completed', sessionId, tsUtc, promptId: asString(update.prompt_id), usages };
}

/** The agent clock (ms) is the event time; the envelope second is a fallback. */
function turnTimestamp(
  params: Record<string, unknown> | null,
  root: Record<string, unknown> | null,
): number | null {
  const agentMs = asObject(params?._meta ?? null)?.agentTimestampMs;
  if (typeof agentMs === 'number' && Number.isFinite(agentMs)) {
    const seconds = Math.floor(agentMs / MILLISECONDS_PER_SECOND);
    if (seconds >= EPOCH_SECONDS_MIN && seconds <= EPOCH_SECONDS_MAX) {
      return seconds;
    }
  }
  const envelope = root?.timestamp;
  if (
    typeof envelope === 'number' &&
    Number.isInteger(envelope) &&
    envelope >= EPOCH_SECONDS_MIN &&
    envelope <= EPOCH_SECONDS_MAX
  ) {
    return envelope;
  }
  return null;
}

/**
 * `modelUsage` is the authoritative per-model split and its keys are the
 * billed model ids (`grok-4.6-build`), which the user-facing `modelId`
 * (`grok-4.6`) is not. Only when it is absent does the aggregate stand in,
 * and then the model is unknown rather than guessed.
 */
function modelUsages(usage: Record<string, unknown>): GrokModelUsage[] {
  const perModel = asObject(usage.modelUsage);
  const entries = perModel === null ? [] : Object.entries(perModel);
  if (entries.length === 0) {
    const aggregate = toModelUsage(usage, null);
    return aggregate === null ? [] : [aggregate];
  }
  const usages: GrokModelUsage[] = [];
  for (const [model, raw] of entries) {
    const record = asObject(raw);
    if (record === null) {
      continue;
    }
    const parsed = toModelUsage(record, model);
    if (parsed !== null) {
      usages.push(parsed);
    }
  }
  return usages;
}

function toModelUsage(record: Record<string, unknown>, model: string | null): GrokModelUsage | null {
  const inputTokens = asTokenCount(record.inputTokens);
  const outputTokens = asTokenCount(record.outputTokens);
  const cacheRead = asTokenCount(record.cachedReadTokens);
  const cacheWrite = asTokenCount(record.cacheCreationTokens);
  const reasoningTokens = asTokenCount(record.reasoningTokens);
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheRead === null ||
    cacheWrite === null ||
    reasoningTokens === null
  ) {
    return null;
  }
  return {
    model: model ?? '',
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    reasoningTokens,
    costUsd: costUsdFrom(record.costUsdTicks),
  };
}

function costUsdFrom(ticks: unknown): number | null {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks < 0) {
    return null;
  }
  return ticks / GROK_COST_TICKS_PER_USD;
}
