import type { ClaudeUsageRecord, ClaudeUserRecord } from './records.ts';

const MAIN_BRANCH_KEY = 'main';
const SIDECHAIN_KEY_PREFIX = 'sidechain:';
// pending prompts are serialized into scan_state.cursor_json on every
// batch, so unbounded sidechain accumulation would bloat the cursor
const MAX_SIDECHAIN_PROMPTS = 256;

export type PendingPrompt = {
  readonly promptText: string;
  readonly userUuid: string | null;
  readonly parentUuid: string | null;
};

export type PendingPromptMap = { readonly [branchKey: string]: PendingPrompt };

/**
 * Tracks the last eligible user prompt per conversation branch so usage
 * records can be attributed to the prompt that produced them. Main-branch
 * prompts are keyed as a single slot; sidechain prompts are keyed by the
 * uuid chain so a subagent's usage never steals the main prompt. A prompt
 * is intentionally not cleared after a hit: several assistant records can
 * answer one prompt.
 */
export class PromptTracker {
  readonly #prompts: Map<string, PendingPrompt>;

  constructor(initial: PendingPromptMap = {}) {
    this.#prompts = new Map(Object.entries(initial));
  }

  recordUserPrompt(record: ClaudeUserRecord): void {
    const pending: PendingPrompt = {
      promptText: record.promptText,
      userUuid: record.uuid,
      parentUuid: record.parentUuid,
    };
    if (!record.isSidechain) {
      this.#prompts.set(MAIN_BRANCH_KEY, pending);
      return;
    }
    if (record.uuid === null) {
      return;
    }
    this.#setSidechain(`${SIDECHAIN_KEY_PREFIX}${record.uuid}`, pending);
  }

  resolvePrompt(record: ClaudeUsageRecord): string | null {
    if (!record.isSidechain) {
      return this.#prompts.get(MAIN_BRANCH_KEY)?.promptText ?? null;
    }
    if (record.parentUuid === null) {
      return null;
    }
    const pending = this.#prompts.get(`${SIDECHAIN_KEY_PREFIX}${record.parentUuid}`);
    if (pending === undefined) {
      return null;
    }
    if (record.uuid !== null) {
      this.#setSidechain(`${SIDECHAIN_KEY_PREFIX}${record.uuid}`, pending);
    }
    return pending.promptText;
  }

  #setSidechain(branchKey: string, pending: PendingPrompt): void {
    this.#prompts.set(branchKey, pending);
    if (this.#prompts.size <= MAX_SIDECHAIN_PROMPTS + 1) {
      return;
    }
    for (const key of this.#prompts.keys()) {
      if (key !== MAIN_BRANCH_KEY && key !== branchKey) {
        this.#prompts.delete(key);
        break;
      }
    }
  }

  toJson(): PendingPromptMap {
    return Object.fromEntries(this.#prompts);
  }

  static fromJson(value: unknown): PromptTracker {
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
      return new PromptTracker();
    }
    const restored: Record<string, PendingPrompt> = {};
    for (const [branchKey, candidate] of Object.entries(value)) {
      const pending = asPendingPrompt(candidate);
      if (pending !== null) {
        restored[branchKey] = pending;
      }
    }
    return new PromptTracker(restored);
  }
}

function asPendingPrompt(value: unknown): PendingPrompt | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.promptText !== 'string') {
    return null;
  }
  return {
    promptText: record.promptText,
    userUuid: typeof record.userUuid === 'string' ? record.userUuid : null,
    parentUuid: typeof record.parentUuid === 'string' ? record.parentUuid : null,
  };
}
