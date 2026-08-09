import { asObject, asString, isNonNegativeInteger } from '../shared.ts';
import type {
  CodexTokenCountRecord,
  CodexTokenUsage,
  CodexTurnContextRecord,
} from './records.ts';

export type ActiveCodexTurn = {
  readonly turnId: string;
  readonly model: string;
  readonly effort: string | null;
  readonly cwd: string | null;
  readonly promptText: string | null;
  readonly acceptedUsageOrdinal: number;
  readonly lastTotalUsageHash: string | null;
};

export type CodexUsageDecision =
  | { readonly kind: 'accepted'; readonly ordinal: number; readonly turn: ActiveCodexTurn }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'no_turn' };

interface MutableTurn {
  turnId: string;
  model: string;
  effort: string | null;
  cwd: string | null;
  promptText: string | null;
  acceptedUsageOrdinal: number;
  lastTotalUsageHash: string | null;
}

/**
 * Correlates codex turns with usage events. The ordinal only advances for
 * usage-bearing events whose cumulative total changed: subagent replays
 * and repeated snapshots (measured 3,547 in real data) therefore reuse
 * the same ordinal and dedupe through the natural key.
 */
export class CodexTurnTracker {
  #pendingPrompt: string | null;
  #activeTurn: MutableTurn | null;

  constructor(pendingPrompt: string | null = null, activeTurn: ActiveCodexTurn | null = null) {
    this.#pendingPrompt = pendingPrompt;
    this.#activeTurn = activeTurn === null ? null : { ...activeTurn };
  }

  recordUserPrompt(promptText: string): void {
    const turn = this.#activeTurn;
    if (turn !== null && turn.acceptedUsageOrdinal === 0) {
      turn.promptText = promptText;
      return;
    }
    this.#pendingPrompt = promptText;
  }

  startTurn(record: CodexTurnContextRecord): void {
    this.#activeTurn = {
      turnId: record.turnId,
      model: record.model,
      effort: record.effort,
      cwd: record.cwd,
      promptText: this.#pendingPrompt,
      acceptedUsageOrdinal: 0,
      lastTotalUsageHash: null,
    };
    this.#pendingPrompt = null;
  }

  acceptUsage(record: CodexTokenCountRecord): CodexUsageDecision {
    const turn = this.#activeTurn;
    if (turn === null) {
      return { kind: 'no_turn' };
    }
    const hash = usageHash(record.total);
    if (hash === turn.lastTotalUsageHash) {
      return { kind: 'duplicate' };
    }
    turn.acceptedUsageOrdinal += 1;
    turn.lastTotalUsageHash = hash;
    return { kind: 'accepted', ordinal: turn.acceptedUsageOrdinal, turn: { ...turn } };
  }

  toJson(): { pendingPrompt: string | null; activeTurn: ActiveCodexTurn | null } {
    return {
      pendingPrompt: this.#pendingPrompt,
      activeTurn: this.#activeTurn === null ? null : { ...this.#activeTurn },
    };
  }

  static fromJson(pendingPrompt: unknown, activeTurn: unknown): CodexTurnTracker {
    return new CodexTurnTracker(
      typeof pendingPrompt === 'string' ? pendingPrompt : null,
      asActiveTurn(activeTurn),
    );
  }
}

export function usageHash(usage: CodexTokenUsage): string {
  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
  ].join(':');
}

function asActiveTurn(value: unknown): ActiveCodexTurn | null {
  const record = asObject(value);
  if (record === null) {
    return null;
  }
  const turnId = asString(record.turnId);
  const model = asString(record.model);
  if (
    turnId === null ||
    model === null ||
    !isNonNegativeInteger(record.acceptedUsageOrdinal)
  ) {
    return null;
  }
  return {
    turnId,
    model,
    effort: asString(record.effort),
    cwd: asString(record.cwd),
    promptText: asString(record.promptText),
    acceptedUsageOrdinal: record.acceptedUsageOrdinal,
    lastTotalUsageHash: asString(record.lastTotalUsageHash),
  };
}
