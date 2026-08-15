import type { PromptListResult, PromptRow } from '@llmtally/core/report/prompts.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';

export interface PromptRowViewModel {
  readonly id: number;
  readonly tsUtc: number;
  readonly agent: string;
  readonly model: string;
  readonly effort: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoningTokens: number;
  /** Settlement class deciding the `$`/`~$`/`?$` prefix. */
  readonly nature: 'quota' | 'spend' | 'unknown';
  readonly costUsd: number | null;
  /** Single line: prompts are multi-line and the list is one row each. */
  readonly text: string;
  /** API calls folded into this prompt (tool round-trips included). */
  readonly calls: number;
  /** A subagent's prompt, not one the user typed. */
  readonly isSidechain: boolean;
}

export interface PromptsViewModel {
  readonly rows: readonly PromptRowViewModel[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  /** What produced this list, shown in the header. */
  readonly scope: string;
}

/**
 * Prompt bodies are the least trusted text in the ledger — they are
 * whatever the user (or a tool) typed — so they are flattened to one
 * line and stripped of control characters before anything renders them.
 */
function toSingleLine(text: string): string {
  return sanitizeTerminalLine(text.replace(/\s+/gu, ' ')).trim();
}

export function toPromptsViewModel(result: PromptListResult, scope: string): PromptsViewModel {
  return {
    rows: result.rows.map((row: PromptRow) => ({
      id: row.id,
      tsUtc: row.tsUtc,
      agent: sanitizeTerminalLine(row.agent),
      model: sanitizeTerminalLine(row.model),
      effort: row.effort === null ? null : sanitizeTerminalLine(row.effort),
      inputTokens: row.tokens.inputTokens,
      outputTokens: row.tokens.outputTokens,
      cacheRead: row.tokens.cacheRead,
      cacheWrite: row.tokens.cacheWrite,
      reasoningTokens: row.tokens.reasoningTokens,
      nature: row.nature,
      costUsd: row.costUsd,
      text: toSingleLine(row.text),
      calls: row.calls,
      isSidechain: row.isSidechain,
    })),
    truncated: result.truncated,
    warnings: result.warnings.map((warning) => sanitizeTerminalLine(warning)),
    scope: sanitizeTerminalLine(scope),
  };
}
