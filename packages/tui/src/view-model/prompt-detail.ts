import type { PromptDetail } from '@llmtally/core/report/prompts.ts';
import type { TokenTotals } from '@llmtally/core/pricing/types.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';

export interface PromptCallViewModel {
  readonly id: number;
  readonly tsUtc: number;
  readonly model: string;
  readonly effort: string | null;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
}

/**
 * One prompt opened from a list: header facts, totals, every call, and
 * the body kept line by line (the list flattens it; here the user reads
 * it as typed). Each line is stripped of control characters — prompt
 * text is the least trusted string in the ledger.
 */
export interface PromptDetailViewModel {
  readonly id: number;
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string;
  readonly effort: string | null;
  readonly nature: 'quota' | 'spend' | 'unknown';
  readonly isSidechain: boolean;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly firstTsUtc: number;
  readonly lastTsUtc: number;
  readonly calls: readonly PromptCallViewModel[];
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
  /** The prompt body, one entry per source line, empty when not stored. */
  readonly textLines: readonly string[];
  readonly warnings: readonly string[];
}

function toTextLines(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split(/\r?\n/u).map((line) => sanitizeTerminalLine(line.replace(/\t/gu, '    ')));
}

export function toPromptDetailViewModel(detail: PromptDetail): PromptDetailViewModel {
  const { prompt } = detail;
  return {
    id: prompt.id,
    agent: sanitizeTerminalLine(prompt.agent),
    provider: detail.provider === null ? null : sanitizeTerminalLine(detail.provider),
    model: sanitizeTerminalLine(prompt.model),
    effort: prompt.effort === null ? null : sanitizeTerminalLine(prompt.effort),
    nature: prompt.nature,
    isSidechain: prompt.isSidechain,
    sessionId: detail.sessionId === null ? null : sanitizeTerminalLine(detail.sessionId),
    cwd: detail.cwd === null ? null : sanitizeTerminalLine(detail.cwd),
    firstTsUtc: prompt.tsUtc,
    lastTsUtc: detail.lastTsUtc,
    calls: detail.calls.map((call) => ({
      id: call.id,
      tsUtc: call.tsUtc,
      model: sanitizeTerminalLine(call.model),
      effort: call.effort === null ? null : sanitizeTerminalLine(call.effort),
      tokens: call.tokens,
      costUsd: call.costUsd,
    })),
    tokens: prompt.tokens,
    costUsd: prompt.costUsd,
    textLines: toTextLines(prompt.text),
    warnings: detail.warnings.map((warning) => sanitizeTerminalLine(warning)),
  };
}
