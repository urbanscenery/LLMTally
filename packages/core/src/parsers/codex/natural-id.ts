import { createHash } from 'node:crypto';

import type { CodexTokenUsage } from './records.ts';

const DIGEST_HEX_LENGTH = 16;

export interface CodexNaturalIdInput {
  readonly turnId: string | null;
  readonly usageDigest: string | null;
  readonly rolloutId: string | null;
  readonly lineStartOffset: number;
}

/**
 * Content digest of one usage event. An ordinal was measured to LOSE
 * data: resumed rollouts re-emit turn_context for the same turn_id,
 * resetting any counter, so distinct usage collided on the same key
 * (real data: 1,900 conflicting ids, 3,271 distinct payloads dropped).
 * The cumulative total makes the digest unique per real event within a
 * turn, while subagent replays reproduce byte-identical usage and thus
 * dedupe to the same id.
 */
export function usageDigest(last: CodexTokenUsage, total: CodexTokenUsage): string {
  const canonical = [
    last.inputTokens,
    last.cachedInputTokens,
    last.cacheWriteInputTokens,
    last.outputTokens,
    last.reasoningOutputTokens,
    last.totalTokens,
    total.inputTokens,
    total.cachedInputTokens,
    total.cacheWriteInputTokens,
    total.outputTokens,
    total.reasoningOutputTokens,
    total.totalTokens,
  ].join(':');
  return createHash('sha256').update(canonical).digest('hex').slice(0, DIGEST_HEX_LENGTH);
}

/**
 * The rollout+offset fallback only covers turnless usage (154 events in
 * 6 legacy files); rollout ids alone would double-count subagent replays.
 */
export function buildCodexNaturalId(input: CodexNaturalIdInput): string | null {
  if (input.turnId !== null && input.usageDigest !== null) {
    return `turn:${input.turnId}:usage:${input.usageDigest}`;
  }
  if (input.rolloutId !== null) {
    return `rollout:${input.rolloutId}:offset:${input.lineStartOffset}`;
  }
  return null;
}
