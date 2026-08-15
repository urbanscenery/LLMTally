/**
 * Attributes a generation to the user-input step that produced it.
 *
 * A conversation database lists its steps in idx order; the user's
 * prompts are the step_type-14 rows, and every generation records (in
 * gen_metadata #2) the step indices it covered. The prompt behind a
 * generation is therefore the last user-input step BEFORE the smallest
 * covered index — verified on multi-prompt conversations where each
 * prompt's generations sit strictly between it and the next prompt.
 * When a generation carries no step indices the step and generation
 * timestamps order them instead.
 */
export interface AntigravityPrompt {
  readonly idx: number;
  readonly tsUtc: number | null;
  readonly text: string;
}

export interface ResolvedPrompt {
  readonly idx: number;
  readonly text: string;
}

/** `prompts` must be sorted by idx ascending (the SELECT orders them). */
export function resolvePromptForGeneration(
  prompts: readonly AntigravityPrompt[],
  stepIndices: readonly number[] | null,
  generationTsUtc: number,
): ResolvedPrompt | null {
  if (stepIndices !== null && stepIndices.length > 0) {
    const firstCoveredIdx = Math.min(...stepIndices);
    return lastPromptWhere(prompts, (prompt) => prompt.idx < firstCoveredIdx);
  }
  return lastPromptWhere(
    prompts,
    (prompt) => prompt.tsUtc !== null && prompt.tsUtc <= generationTsUtc,
  );
}

function lastPromptWhere(
  prompts: readonly AntigravityPrompt[],
  matches: (prompt: AntigravityPrompt) => boolean,
): ResolvedPrompt | null {
  for (let index = prompts.length - 1; index >= 0; index -= 1) {
    const prompt = prompts[index];
    if (prompt !== undefined && matches(prompt)) {
      return { idx: prompt.idx, text: prompt.text };
    }
  }
  return null;
}
