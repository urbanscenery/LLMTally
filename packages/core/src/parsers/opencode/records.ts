import type { LedgerEntry } from '../../domain/types.ts';
import { asObject, asString, asTokenCount } from '../shared.ts';
import { OPENCODE_AGENT, OPENCODE_PARSER_VERSION } from './constants.ts';
import type { OpenCodeJoinedRow } from './query.ts';

const MILLISECONDS_PER_SECOND = 1000;

export interface AssistantCandidate {
  readonly id: string;
  readonly sessionId: string | null;
  readonly timeUpdated: number;
  readonly dataJson: string;
  /** The user message this assistant answered (data.parentID join). */
  readonly userId: string | null;
  readonly parts: readonly { readonly id: string; readonly dataJson: string }[];
}

export interface NormalizedAssistant {
  readonly kind: 'entry';
  readonly entry: LedgerEntry;
  readonly hasMalformedPart: boolean;
  readonly hasInvalidCost: boolean;
}

export interface InvalidAssistant {
  readonly kind: 'invalid';
  readonly reason: string;
}

/** Groups the flat joined rows (ordered by assistant, then part id). */
export function groupJoinedRows(rows: readonly OpenCodeJoinedRow[]): AssistantCandidate[] {
  const candidates: AssistantCandidate[] = [];
  let current: {
    id: string;
    sessionId: string | null;
    timeUpdated: number;
    dataJson: string;
    userId: string | null;
    parts: { id: string; dataJson: string }[];
  } | null = null;

  for (const row of rows) {
    if (current === null || current.id !== row.assistantId) {
      if (current !== null) {
        candidates.push(current);
      }
      current = {
        id: row.assistantId,
        sessionId: row.assistantSessionId,
        timeUpdated: row.assistantTimeUpdated,
        dataJson: row.assistantData,
        userId: row.userId,
        parts: [],
      };
    }
    if (row.partId !== null && row.partData !== null) {
      current.parts.push({ id: row.partId, dataJson: row.partData });
    }
  }
  if (current !== null) {
    candidates.push(current);
  }
  return candidates;
}

export function normalizeAssistant(
  candidate: AssistantCandidate,
): NormalizedAssistant | InvalidAssistant {
  let data: Record<string, unknown> | null;
  try {
    data = asObject(JSON.parse(candidate.dataJson));
  } catch {
    data = null;
  }
  if (data === null) {
    return { kind: 'invalid', reason: 'assistant message data is not a JSON object' };
  }
  if (data.role !== 'assistant') {
    return { kind: 'invalid', reason: 'message data role is not assistant' };
  }
  const time = asObject(data.time);
  const completed = time?.completed;
  if (typeof completed !== 'number' || !Number.isFinite(completed) || completed < 0) {
    return { kind: 'invalid', reason: 'assistant message has no valid completion time' };
  }
  const model = asString(data.modelID);
  if (model === null || model.length === 0) {
    return { kind: 'invalid', reason: 'assistant message has no model id' };
  }
  const tokens = asObject(data.tokens) ?? {};
  const cache = asObject(tokens.cache) ?? {};
  const inputTokens = asTokenCount(tokens.input);
  const outputTokens = asTokenCount(tokens.output);
  const reasoningTokens = asTokenCount(tokens.reasoning);
  const cacheWrite = asTokenCount(cache.write);
  const cacheRead = asTokenCount(cache.read);
  if (
    inputTokens === null ||
    outputTokens === null ||
    reasoningTokens === null ||
    cacheWrite === null ||
    cacheRead === null
  ) {
    return { kind: 'invalid', reason: 'assistant token counts are not non-negative integers' };
  }
  const cost = asCost(data.cost);
  const prompt = extractPrompt(candidate.parts);
  const path = asObject(data.path);

  return {
    kind: 'entry',
    hasMalformedPart: prompt.hasMalformedPart,
    hasInvalidCost: cost.invalid,
    entry: {
      tsUtc: Math.floor(completed / MILLISECONDS_PER_SECOND),
      agent: OPENCODE_AGENT,
      account: null,
      provider: asString(data.providerID),
      model,
      effort: asString(data.variant),
      promptText: prompt.text,
      // the user message id is opencode's own prompt identity; every
      // assistant step of one turn points at it through data.parentID
      promptKey: candidate.userId,
      inputTokens,
      outputTokens,
      cacheWrite,
      cacheRead,
      reasoningTokens,
      costUsd: cost.value,
      sessionId: candidate.sessionId,
      cwd: path === null ? null : asString(path.cwd),
      naturalId: candidate.id,
      parserVersion: OPENCODE_PARSER_VERSION,
      isSidechain: false,
      parentUuid: asString(data.parentID),
    },
  };
}

function extractPrompt(parts: readonly { readonly id: string; readonly dataJson: string }[]): {
  text: string | null;
  hasMalformedPart: boolean;
} {
  const texts: string[] = [];
  let hasMalformedPart = false;
  for (const part of parts) {
    let data: Record<string, unknown> | null;
    try {
      data = asObject(JSON.parse(part.dataJson));
    } catch {
      data = null;
    }
    if (data === null) {
      hasMalformedPart = true;
      continue;
    }
    if (data.type === 'text' && typeof data.text === 'string' && data.text.length > 0) {
      texts.push(data.text);
    }
  }
  return { text: texts.length > 0 ? texts.join('\n') : null, hasMalformedPart };
}

function asCost(value: unknown): { value: number | null; invalid: boolean } {
  if (value === undefined || value === null) {
    return { value: null, invalid: false };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    // the source cost is authoritative — never replace a broken value
    // with a computed one, just record null and surface a warning
    return { value: null, invalid: true };
  }
  return { value, invalid: false };
}
