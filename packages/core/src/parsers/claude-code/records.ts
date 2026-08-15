export const CLAUDE_AGENT = 'claude-code';
export const CLAUDE_PROVIDER = 'anthropic';
export const CLAUDE_PARSER_VERSION = 3;

const MILLISECONDS_PER_SECOND = 1000;
const SYSTEM_MESSAGE_PREFIX = '<';
// a slash command is logged as XML-ish tags rather than the typed line;
// the name (with its leading slash) plus the args is what the user typed
const COMMAND_TAG_PREFIXES = ['<command-name>', '<command-message>'] as const;
const AGENT_TOOL_NAME = 'Agent';
const COMMAND_NAME_PATTERN = /<command-name>([\s\S]*?)<\/command-name>/u;
const COMMAND_ARGS_PATTERN = /<command-args>([\s\S]*?)<\/command-args>/u;

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
  /**
   * The prompt this assistant record handed to a spawned agent (the
   * `Agent` tool_use input). A fork transcript opens with a copy of that
   * parent record instead of a user prompt, so it is the only prompt the
   * fork's usage can be attributed to.
   */
  readonly spawnedPrompt: string | null;
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

/**
 * A record that neither prompts nor bills but sits on the uuid chain
 * (attachments, tool results, system notes, meta users). Sidechain
 * attribution has to hop across it to reach the next assistant record.
 */
export interface ClaudeLinkRecord {
  readonly kind: 'link';
  readonly uuid: string | null;
  readonly parentUuid: string | null;
  readonly isSidechain: boolean;
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
  | ClaudeLinkRecord
  | ClaudeSkippedRecord
  | ClaudeMalformedRecord
  | ClaudeInvalidRecord;

const SKIPPED: ClaudeSkippedRecord = { kind: 'skipped' };

/**
 * Cheap string prefilter applied before JSON.parse. Usage records always
 * contain "usage"; user records are matched independently because prompt
 * correlation must see them even though they carry no usage block. Every
 * sidechain record is a candidate too: subagent attribution walks the
 * uuid chain, and the hops between prompt and answer (attachments, tool
 * results) carry neither marker.
 */
export function isCandidateLine(line: string): boolean {
  return (
    line.includes('"usage"') ||
    line.includes('"type":"user"') ||
    line.includes('"type": "user"') ||
    line.includes('"isSidechain":true') ||
    line.includes('"isSidechain": true')
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
  return linkOrSkip(raw);
}

/** Records without a uuid cannot be on any chain, so there is nothing to link. */
function linkOrSkip(raw: Record<string, unknown>): ClaudeLinkRecord | ClaudeSkippedRecord {
  const uuid = asString(raw.uuid);
  if (uuid === null || uuid.length === 0) {
    return SKIPPED;
  }
  return {
    kind: 'link',
    uuid,
    parentUuid: asString(raw.parentUuid),
    isSidechain: raw.isSidechain === true,
  };
}

function classifyUser(
  raw: Record<string, unknown>,
): ClaudeUserRecord | ClaudeLinkRecord | ClaudeSkippedRecord {
  if (raw.isMeta === true) {
    return linkOrSkip(raw);
  }
  const message = asObject(raw.message);
  const promptText = eligiblePromptText(extractPromptText(message?.content));
  if (promptText === null) {
    return linkOrSkip(raw);
  }
  return {
    kind: 'user',
    uuid: asString(raw.uuid),
    parentUuid: asString(raw.parentUuid),
    isSidechain: raw.isSidechain === true,
    promptText,
  };
}

/**
 * Filters injected / system-ish user content. Slash commands are the one
 * `<`-prefixed shape that IS the user's own input, so they are rebuilt
 * into the typed form; every other tag-led message (local command
 * output, caveats, system reminders) is not a prompt.
 */
function eligiblePromptText(text: string | null): string | null {
  if (text === null || text.length === 0) {
    return null;
  }
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(SYSTEM_MESSAGE_PREFIX)) {
    return text;
  }
  if (COMMAND_TAG_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return slashCommandPrompt(trimmed);
  }
  return null;
}

function slashCommandPrompt(text: string): string | null {
  const name = COMMAND_NAME_PATTERN.exec(text)?.[1]?.trim() ?? '';
  if (name.length === 0) {
    return null;
  }
  const args = COMMAND_ARGS_PATTERN.exec(text)?.[1]?.trim() ?? '';
  return args.length === 0 ? name : `${name} ${args}`;
}

function classifyAssistant(
  raw: Record<string, unknown>,
): ClaudeUsageRecord | ClaudeLinkRecord | ClaudeSkippedRecord | ClaudeInvalidRecord {
  const message = asObject(raw.message);
  const usage = asObject(message?.usage);
  if (usage === null) {
    return linkOrSkip(raw);
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
    spawnedPrompt: extractSpawnedPrompt(message?.content),
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

/** The `prompt` given to the Agent tool, verbatim; the description is not the prompt. */
function extractSpawnedPrompt(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    const object = asObject(block);
    if (object === null || object.type !== 'tool_use' || object.name !== AGENT_TOOL_NAME) {
      continue;
    }
    const prompt = asString(asObject(object.input)?.prompt);
    if (prompt !== null && prompt.trim().length > 0) {
      return prompt;
    }
  }
  return null;
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
