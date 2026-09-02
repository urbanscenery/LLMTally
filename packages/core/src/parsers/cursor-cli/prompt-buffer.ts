import { asObject, asString } from '../shared.ts';

export interface CursorCliPendingPrompt {
  readonly text: string;
  readonly promptKey: string | null;
}

/**
 * Joins a user event with the usage that bills it. Prompt text arrives
 * first; assistant/result usage arrives later, possibly in a later
 * scan batch, so the pending prompt is persisted in cursor_json.
 */
export class CursorCliPromptBuffer {
  #pending: CursorCliPendingPrompt | null;

  constructor(pending: CursorCliPendingPrompt | null = null) {
    this.#pending = pending;
  }

  /** A new user message replaces any prompt that was never billed. */
  set(prompt: CursorCliPendingPrompt): void {
    this.#pending = prompt;
  }

  take(): CursorCliPendingPrompt | null {
    const pending = this.#pending;
    this.#pending = null;
    return pending;
  }

  toJson(): CursorCliPendingPrompt | null {
    return this.#pending;
  }

  static fromJson(value: unknown): CursorCliPromptBuffer {
    const record = asObject(value);
    if (record === null) {
      return new CursorCliPromptBuffer();
    }
    const text = asString(record.text);
    if (text === null) {
      return new CursorCliPromptBuffer();
    }
    return new CursorCliPromptBuffer({
      text,
      promptKey: asString(record.promptKey),
    });
  }
}
