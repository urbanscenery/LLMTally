import { asObject, asString } from '../shared.ts';

export interface GrokPendingPrompt {
  readonly promptIndex: number | null;
  readonly text: string;
  readonly modelId: string | null;
}

/**
 * Correlates a Grok prompt with the turn that bills it. Prompt text
 * arrives as `user_message_chunk` records and the usage arrives later as
 * `turn_completed`, so the pending prompt has to survive across scan
 * batches (and across runs, through cursor_json) or a turn whose prompt
 * landed in an earlier batch would be written with no prompt at all.
 */
export class GrokPromptBuffer {
  #pending: GrokPendingPrompt | null;

  constructor(pending: GrokPendingPrompt | null = null) {
    this.#pending = pending;
  }

  /** Chunks of one prompt concatenate; a new promptIndex starts over. */
  append(chunk: GrokPendingPrompt): void {
    const pending = this.#pending;
    if (pending !== null && pending.promptIndex === chunk.promptIndex) {
      this.#pending = {
        promptIndex: pending.promptIndex,
        text: pending.text + chunk.text,
        modelId: chunk.modelId ?? pending.modelId,
      };
      return;
    }
    this.#pending = chunk;
  }

  /** A completed turn consumes its prompt exactly once. */
  take(): GrokPendingPrompt | null {
    const pending = this.#pending;
    this.#pending = null;
    return pending;
  }

  toJson(): GrokPendingPrompt | null {
    return this.#pending;
  }

  static fromJson(value: unknown): GrokPromptBuffer {
    const record = asObject(value);
    if (record === null) {
      return new GrokPromptBuffer();
    }
    const text = asString(record.text);
    if (text === null) {
      return new GrokPromptBuffer();
    }
    const index = record.promptIndex;
    return new GrokPromptBuffer({
      promptIndex: typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null,
      text,
      modelId: asString(record.modelId),
    });
  }
}
