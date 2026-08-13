export const CLAUDE_AGENT = 'claude-code';
export const CLAUDE_PROVIDER = 'anthropic';
export const CLAUDE_PARSER_VERSION = 2;

const MILLISECONDS_PER_SECOND = 1000;
const SYSTEM_MESSAGE_PREFIX = '<';

export interface ClaudeUserRecord {
  readonly kind: 'user';
  readonly uuid: string | null;
  readonly parentUuid: string | null;
  readonly isSidechain: boolean;
  readonly promptText: string;
}

export interface ClaudeUsageRecord {
  readonly kind: 'usage';
  readonly uuid: string | null;
  readonly messageId: string | null;
  readonly parentUuid: string | null;
  readonly isSidechain: boolean;
  readonly tsUtc: number;
  readonly model: string;
  readonly effort: string | null;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

export interface ClaudeSkippedRecord {
  readonly kind: 'skipped';
}

export interface ClaudeMalformedRecord {
  readonly kind: 'malformed';
  readonly reason: string;
}

export interface ClaudeInvalidRecord {
  readonly kind: 'invalid';
  readonly reason: string;
}

export type ClassifiedClaudeLine =
  | ClaudeUserRecord
  | ClaudeUsageRecord
  | ClaudeSkippedRecord
  | ClaudeMalformedRecord
  | ClaudeInvalidRecord;

const SKIPPED: ClaudeSkippedRecord = { kind: 'skipped' };

/**
 * Cheap string prefilter applied before JSON.parse. Usage records always
 * contain "usage"; user records are matched independently because prompt
 * correlation must see them even though they carry no usage block.
 */
export function isCandidateLine(line: string): boolean {
  return (
    line.includes('"usage"') ||
    line.includes('"type":"user"') ||
    line.includes('"type": "user"')
  );
}

export function classifyClaudeLine(line: string): ClassifiedClaudeLine {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // engine parse errors can quote raw source tokens, which may contain
    // prompt fragments — never forward them into warnings
    return { kind: 'malformed', reason: 'line is not parseable as JSON' };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { kind: 'malformed', reason: 'line is not a JSON object' };
  }
  const raw = record as Record<string, unknown>;
  if (raw.type === 'user') {
    return classifyUser(raw);
  }
  if (raw.type === 'assistant') {
    return classifyAssistant(raw);
  }
  return SKIPPED;
}

function classifyUser(raw: Record<string, unknown>): ClaudeUserRecord | ClaudeSkippedRecord {
  if (raw.isMeta === true) {
    return SKIPPED;
  }
  const message = asObject(raw.message);
  const promptText = extractPromptText(message?.content);
  if (promptText === null || promptText.length === 0) {
    return SKIPPED;
  }
  if (promptText.trimStart().startsWith(SYSTEM_MESSAGE_PREFIX)) {
    return SKIPPED;
  }
  return {
    kind: 'user',
    uuid: asString(raw.uuid),
    parentUuid: asString(raw.parentUuid),
    isSidechain: raw.isSidechain === true,
    promptText,
  };
}

function classifyAssistant(
  raw: Record<string, unknown>,
): ClaudeUsageRecord | ClaudeSkippedRecord | ClaudeInvalidRecord {
  const message = asObject(raw.message);
  const usage = asObject(message?.usage);
  if (usage === null) {
    return SKIPPED;
  }
  const model = asString(message?.model);
  if (model === null || model.length === 0) {
    return { kind: 'invalid', reason: 'assistant usage record has no model' };
  }
  const tsUtc = parseUtcTimestamp(raw.timestamp);
  if (tsUtc === null) {
    return { kind: 'invalid', reason: 'assistant usage record has no valid UTC timestamp' };
  }
  const inputTokens = asTokenCount(usage.input_tokens);
  const outputTokens = asTokenCount(usage.output_tokens);
  const cacheWrite = asTokenCount(usage.cache_creation_input_tokens);
  const cacheRead = asTokenCount(usage.cache_read_input_tokens);
  if (inputTokens === null || outputTokens === null || cacheWrite === null || cacheRead === null) {
    return { kind: 'invalid', reason: 'assistant usage record has non-integer token counts' };
  }
  return {
    kind: 'usage',
    uuid: asString(raw.uuid),
    messageId: asString(message?.id),
    parentUuid: asString(raw.parentUuid),
    isSidechain: raw.isSidechain === true,
    tsUtc,
    model,
    effort: asString(raw.effort),
    requestId: asString(raw.requestId),
    sessionId: asString(raw.sessionId),
    cwd: asString(raw.cwd),
    inputTokens,
    outputTokens,
    cacheWrite,
    cacheRead,
  };
}

function extractPromptText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const textBlocks = content
    .map((block) => asObject(block))
    .filter((block): block is Record<string, unknown> => block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  if (textBlocks.length === 0) {
    return null;
  }
  return textBlocks.join('\n');
}

const UTC_DESIGNATOR_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

function parseUtcTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  // Date.parse treats offset-less ISO strings as LOCAL time, which would
  // silently skew ts_utc by the host timezone — reject them instead
  if (!UTC_DESIGNATOR_PATTERN.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    return null;
  }
  return Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
import { asTokenCount } from '../shared.ts';
