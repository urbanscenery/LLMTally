/**
 * Shared terminal-output sanitizers. Every externally sourced string
 * (agent names, models, prompts, provider warnings) must pass through
 * one of these before reaching a terminal, so escape sequences inside
 * source logs cannot inject cursor moves, OSC writes, or title changes.
 */

const LINE_CONTROL_PATTERN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');
const BLOCK_CONTROL_PATTERN = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'g');

/** For single-line cells: strips all C0/C1 controls including tab and newline. */
export function sanitizeTerminalLine(value: string): string {
  return value.replace(LINE_CONTROL_PATTERN, '');
}

/** For multi-line bodies (e.g. prompt previews): keeps LF, strips the rest. */
export function sanitizeTerminalBlock(value: string): string {
  return value.replace(BLOCK_CONTROL_PATTERN, '');
}
