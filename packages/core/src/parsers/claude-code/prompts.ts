import type { ClaudeLinkRecord, ClaudeUsageRecord, ClaudeUserRecord } from './records.ts';

const MAIN_BRANCH_KEY = 'main';
const SIDECHAIN_KEY_PREFIX = 'sidechain:';
/**
 * The most recent sidechain prompt seen in this file. Subagent transcripts
 * are written one file per agent, so when the uuid chain cannot be walked
 * (a record type we never saw, a parent written to another file) the last
 * sidechain prompt of the file is the right owner far more often than none.
 */
const SIDECHAIN_LATEST_KEY = 'sidechain-latest';
// pending prompts are serialized into scan_state.cursor_json on every
// batch, so unbounded sidechain accumulation would bloat the cursor
const MAX_SIDECHAIN_PROMPTS = 256;
const PINNED_KEYS: ReadonlySet<string> = new Set([MAIN_BRANCH_KEY, SIDECHAIN_LATEST_KEY]);

export type PendingPrompt = {
  readonly promptText: string;
  readonly userUuid: string | null;
  readonly parentUuid: string | null;
};

export type PendingPromptMap = { readonly [branchKey: string]: PendingPrompt };

/** What a usage record was attributed to: the words and the prompt's own id. */
export type ResolvedPrompt = {
  readonly promptText: string;
  /** The user record's uuid — the ledger's prompt_key — when it was known. */
  readonly promptKey: string | null;
};

/**
 * Tracks the last eligible user prompt per conversation branch so usage
 * records can be attributed to the prompt that produced them. Main-branch
 * prompts are keyed as a single slot; sidechain prompts are keyed by the
 * uuid chain so a subagent's usage never steals the main prompt. A prompt
 * is intentionally not cleared after a hit: several assistant records can
 * answer one prompt.
 *
 * The chain runs through records that carry no usage themselves
 * (attachments, tool results, system notes) — `link` copies the pending
 * prompt across those hops so the next assistant record still finds it.
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
    this.#prompts.set(SIDECHAIN_LATEST_KEY, pending);
    if (record.uuid === null) {
      return;
    }
    this.#setSidechain(sidechainKey(record.uuid), pending);
  }

  /**
   * A fork transcript starts with a copy of the parent's assistant record
   * that spawned it — its Agent tool_use prompt is the fork's prompt.
   * Registered under the record's own uuid (the fork's chain hangs off
   * it) and as the latest sidechain prompt; the main slot is never
   * touched, so a spawning parent keeps its real prompt.
   */
  recordSpawnedPrompt(record: ClaudeUsageRecord): void {
    if (!record.isSidechain || record.spawnedPrompt === null) {
      return;
    }
    const pending: PendingPrompt = {
      promptText: record.spawnedPrompt,
      userUuid: record.uuid,
      parentUuid: record.parentUuid,
    };
    this.#prompts.set(SIDECHAIN_LATEST_KEY, pending);
    if (record.uuid !== null) {
      this.#setSidechain(sidechainKey(record.uuid), pending);
    }
  }

  /** Carries the pending prompt over a usage-less hop of a sidechain. */
  link(record: ClaudeLinkRecord): void {
    if (!record.isSidechain || record.uuid === null || record.parentUuid === null) {
      return;
    }
    const pending = this.#prompts.get(sidechainKey(record.parentUuid));
    if (pending !== undefined) {
      this.#setSidechain(sidechainKey(record.uuid), pending);
    }
  }

  resolvePrompt(record: ClaudeUsageRecord): ResolvedPrompt | null {
    if (!record.isSidechain) {
      return toResolved(this.#prompts.get(MAIN_BRANCH_KEY));
    }
    const chained =
      record.parentUuid === null ? undefined : this.#prompts.get(sidechainKey(record.parentUuid));
    if (chained !== undefined && record.uuid !== null) {
      this.#setSidechain(sidechainKey(record.uuid), chained);
    }
    return toResolved(chained ?? this.#prompts.get(SIDECHAIN_LATEST_KEY));
  }

  #setSidechain(branchKey: string, pending: PendingPrompt): void {
    this.#prompts.set(branchKey, pending);
    if (this.#prompts.size <= MAX_SIDECHAIN_PROMPTS + PINNED_KEYS.size) {
      return;
    }
    for (const key of this.#prompts.keys()) {
      if (!PINNED_KEYS.has(key) && key !== branchKey) {
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

function sidechainKey(uuid: string): string {
  return `${SIDECHAIN_KEY_PREFIX}${uuid}`;
}

function toResolved(pending: PendingPrompt | undefined): ResolvedPrompt | null {
  if (pending === undefined) {
    return null;
  }
  return { promptText: pending.promptText, promptKey: pending.userUuid };
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
