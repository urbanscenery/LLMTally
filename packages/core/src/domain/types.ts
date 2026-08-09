export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

/** One normalized per-prompt usage record. Timestamps are UTC epoch seconds. */
export interface LedgerEntry {
  readonly tsUtc: number;
  readonly agent: string;
  readonly account: string | null;
  readonly provider: string | null;
  readonly model: string;
  readonly effort: string | null;
  readonly promptText: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly reasoningTokens: number;
  readonly costUsd: number | null;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly naturalId: string;
  readonly parserVersion: number;
  readonly isSidechain: boolean;
  readonly parentUuid: string | null;
}
