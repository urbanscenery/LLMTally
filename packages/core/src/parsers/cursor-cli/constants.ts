export const CURSOR_CLI_AGENT = 'cursor-cli';
export const CURSOR_CLI_PARSER_VERSION = 1;
export const CURSOR_CLI_CURSOR_VERSION = 1;
export const CURSOR_CLI_UNKNOWN_MODEL = 'unknown';

/**
 * First-party Cursor models settle against the Cursor Models pool.
 * Everything else (Claude, GPT, Gemini, …) is unknown until a user
 * override says otherwise — on-demand vs included is not in the log.
 */
export const CURSOR_NATIVE_MODEL = /^(grok-4|composer-)/i;

/** Project directories under ~/.cursor/projects that hold agent JSONL. */
export const CURSOR_CLI_TRANSCRIPTS_SEGMENT = 'agent-transcripts';
