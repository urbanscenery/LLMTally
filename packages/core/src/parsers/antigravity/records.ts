import {
  decodeMessage,
  decodePackedVarints,
  firstBytes,
  firstString,
  firstVarint,
  hasUnusableVarint,
} from './proto.ts';
import { MAX_TOKENS_PER_EVENT } from '../shared.ts';

export const ANTIGRAVITY_AGENT = 'antigravity-cli';
export const ANTIGRAVITY_PROVIDER = 'google';
// v2: prompt text and prompt keys are attributed from the steps table
export const ANTIGRAVITY_PARSER_VERSION = 2;
export const ANTIGRAVITY_FIELD_MAP_VERSION = 2;

/** steps.step_type of the record that carries what the user typed. */
export const USER_INPUT_STEP_TYPE = 14;

/**
 * Pinned field map, measured locally against 2,077 real generations and
 * 332 user-input steps across 973 conversation databases:
 *   gen_metadata blob
 *     #1         generation message
 *       #19        model name (string)
 *       #9.#4.#1   generation timestamp (epoch seconds)
 *       #4         usage message:
 *         #1  fixed system input   #2  new uncached input
 *         #3  total output         #5  cache read
 *         #9  text output          #10 reasoning output
 *         #11 response id (string)
 *     #2         packed varints: the steps.idx values this generation
 *                covers (the prompt is the last user-input step before
 *                the smallest of them)
 *   steps.step_payload blob (step_type 14 only)
 *     #1         step type (varint, 14)
 *     #5.#1.#1   step timestamp (epoch seconds)
 *     #19.#2     prompt text (string); #19.#3.#1 repeats it
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
  if ([fixedInput, newInput, fixedInput + newInput, cacheRead, outputTokens, reasoningTokens]
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

export interface AntigravityPromptRecord {
  readonly kind: 'prompt';
  readonly text: string;
  /** Step timestamp; null when the payload carries none. */
  readonly tsUtc: number | null;
}

export type ParsedStepPrompt =
  | AntigravityPromptRecord
  | { readonly kind: 'skipped' }
  | { readonly kind: 'invalid'; readonly reason: string };

const STEP_TYPE_FIELD = 1;
const STEP_METADATA_FIELD = 5;
const STEP_USER_INPUT_FIELD = 19;
const USER_INPUT_TEXT_FIELD = 2;
const USER_INPUT_ECHO_FIELD = 3;
const GEN_STEP_INDICES_FIELD = 2;

/**
 * Reads the prompt out of a steps.step_payload blob. Rows whose payload
 * does not declare itself a user-input step are skipped (the caller
 * already filters on step_type, so a mismatch is drift, not an error);
 * a user-input step without any text is invalid.
 */
export function parseStepPayloadPrompt(blob: Uint8Array): ParsedStepPrompt {
  const step = decodeMessage(blob);
  if (step === null) {
    return { kind: 'invalid', reason: 'step payload is not a decodable message' };
  }
  if (firstVarint(step, STEP_TYPE_FIELD) !== USER_INPUT_STEP_TYPE) {
    return { kind: 'skipped' };
  }
  const inputBytes = firstBytes(step, STEP_USER_INPUT_FIELD);
  const input = inputBytes === null ? null : decodeMessage(inputBytes);
  if (input === null) {
    return { kind: 'invalid', reason: 'user-input step has no decodable input message' };
  }
  const text = firstString(input, USER_INPUT_TEXT_FIELD) ?? echoedText(input);
  if (text === null || text.trim().length === 0) {
    return { kind: 'invalid', reason: 'user-input step carries no prompt text' };
  }
  return { kind: 'prompt', text, tsUtc: extractStepTimestamp(step) };
}

/** #19.#3.#1 repeats the prompt; used only when #19.#2 is absent. */
function echoedText(input: NonNullable<ReturnType<typeof decodeMessage>>): string | null {
  const echoBytes = firstBytes(input, USER_INPUT_ECHO_FIELD);
  const echo = echoBytes === null ? null : decodeMessage(echoBytes);
  return echo === null ? null : firstString(echo, 1);
}

function extractStepTimestamp(
  step: NonNullable<ReturnType<typeof decodeMessage>>,
): number | null {
  const metadataBytes = firstBytes(step, STEP_METADATA_FIELD);
  const metadata = metadataBytes === null ? null : decodeMessage(metadataBytes);
  const stampBytes = metadata === null ? null : firstBytes(metadata, 1);
  const stamp = stampBytes === null ? null : decodeMessage(stampBytes);
  const seconds = stamp === null ? null : firstVarint(stamp, 1);
  if (seconds === null || seconds < EPOCH_SECONDS_MIN || seconds > EPOCH_SECONDS_MAX) {
    return null;
  }
  return seconds;
}

/**
 * The steps.idx values a generation covers (gen_metadata blob #2). Null
 * when the field is absent or undecodable, so the caller can fall back
 * to timestamps instead of guessing.
 */
export function parseGenStepIndices(blob: Uint8Array): readonly number[] | null {
  const top = decodeMessage(blob);
  const packed = top === null ? null : firstBytes(top, GEN_STEP_INDICES_FIELD);
  if (packed === null) {
    return null;
  }
  return decodePackedVarints(packed);
}
