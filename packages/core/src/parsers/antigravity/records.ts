import {
  decodeMessage,
  firstBytes,
  firstString,
  firstVarint,
  hasUnusableVarint,
} from './proto.ts';
import { MAX_TOKENS_PER_EVENT } from '../shared.ts';

export const ANTIGRAVITY_AGENT = 'antigravity-cli';
export const ANTIGRAVITY_PROVIDER = 'google';
export const ANTIGRAVITY_PARSER_VERSION = 1;
export const ANTIGRAVITY_FIELD_MAP_VERSION = 1;

/**
 * Pinned field map, measured locally against 2,077 real generations:
 *   gen_metadata blob -> #1 (generation message)
 *     #19        model name (string)
 *     #9.#4.#1   generation timestamp (epoch seconds)
 *     #4         usage message:
 *       #1  fixed system input   #2  new uncached input
 *       #3  total output         #5  cache read
 *       #9  text output          #10 reasoning output
 *       #11 response id (string)
 * Invariant enforced fail-closed: #9 + #10 == #3 when #3 is present.
 */
export interface AntigravityUsageRecord {
  readonly kind: 'usage';
  readonly model: string;
  readonly tsUtc: number;
  readonly responseId: string | null;
  readonly inputTokens: number;
  readonly cacheRead: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export type ParsedGenMetadata =
  | AntigravityUsageRecord
  | { readonly kind: 'skipped' }
  | { readonly kind: 'invalid'; readonly reason: string };

export function parseGenMetadataBlob(blob: Uint8Array): ParsedGenMetadata {
  const top = decodeMessage(blob);
  const generationBytes = top === null ? null : firstBytes(top, 1);
  if (generationBytes === null) {
    return { kind: 'invalid', reason: 'blob is not a decodable generation message' };
  }
  const generation = decodeMessage(generationBytes);
  if (generation === null) {
    return { kind: 'invalid', reason: 'generation message is not decodable' };
  }
  const usageBytes = firstBytes(generation, 4);
  const usage = usageBytes === null ? null : decodeMessage(usageBytes);
  if (usage === null) {
    return { kind: 'skipped' };
  }
  // an oversized session-hash varint elsewhere is tolerable, but a token
  // FIELD whose value overflowed must fail closed — treating it as 0
  // would silently under-count usage
  if (hasUnusableVarint(usage, [1, 2, 3, 5, 9, 10])) {
    return { kind: 'invalid', reason: 'usage field value overflowed a safe integer' };
  }

  const fixedInput = firstVarint(usage, 1) ?? 0;
  const newInput = firstVarint(usage, 2) ?? 0;
  const totalOutput = firstVarint(usage, 3);
  const cacheRead = firstVarint(usage, 5) ?? 0;
  const outputTokens = firstVarint(usage, 9) ?? 0;
  const reasoningTokens = firstVarint(usage, 10) ?? 0;
  // the shared per-event token cap applies here too: a corrupt varint
  // below 2^53 would still poison SQL SUM exactness (audit C2-03)
  if ([fixedInput, newInput, cacheRead, outputTokens, reasoningTokens]
      .some((count) => count > MAX_TOKENS_PER_EVENT)) {
    return { kind: 'invalid', reason: 'usage field value exceeds the per-event token cap' };
  }
  if (fixedInput + newInput + cacheRead + outputTokens + reasoningTokens === 0) {
    return { kind: 'skipped' };
  }
  if (totalOutput !== null && outputTokens + reasoningTokens !== totalOutput) {
    return {
      kind: 'invalid',
      reason: 'usage invariant output+reasoning==total failed (possible schema drift)',
    };
  }

  const model = firstString(generation, 19);
  if (model === null || model.length === 0) {
    return { kind: 'invalid', reason: 'generation has usage but no model name' };
  }
  const tsUtc = extractTimestamp(generation);
  if (tsUtc === null) {
    return { kind: 'invalid', reason: 'generation has usage but no timestamp' };
  }
  return {
    kind: 'usage',
    model,
    tsUtc,
    responseId: firstString(usage, 11),
    inputTokens: fixedInput + newInput,
    cacheRead,
    outputTokens,
    reasoningTokens,
  };
}

const EPOCH_SECONDS_MIN = 1_500_000_000;
const EPOCH_SECONDS_MAX = 4_000_000_000;

function extractTimestamp(
  generation: NonNullable<ReturnType<typeof decodeMessage>>,
): number | null {
  const nineBytes = firstBytes(generation, 9);
  const nine = nineBytes === null ? null : decodeMessage(nineBytes);
  const fourBytes = nine === null ? null : firstBytes(nine, 4);
  const four = fourBytes === null ? null : decodeMessage(fourBytes);
  const seconds = four === null ? null : firstVarint(four, 1);
  if (seconds === null || seconds < EPOCH_SECONDS_MIN || seconds > EPOCH_SECONDS_MAX) {
    return null;
  }
  return seconds;
}
