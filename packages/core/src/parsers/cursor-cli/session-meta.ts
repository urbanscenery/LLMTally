import { basename, dirname } from 'node:path';

import { CURSOR_CLI_TRANSCRIPTS_SEGMENT } from './constants.ts';

export interface CursorCliSessionMeta {
  readonly cwd: string | null;
  readonly sessionId: string | null;
}

/**
 * Path-only session context. A resumed scan starts at a byte offset and
 * never replays `system.init`, so cwd and session id must be recoverable
 * from the file path:
 * `~/.cursor/projects/<percent-encoded-cwd>/agent-transcripts/<id>/<id>.jsonl`
 */
export function readCursorCliSessionMeta(jsonlPath: string): CursorCliSessionMeta {
  const sessionDir = dirname(jsonlPath);
  const transcriptsDir = dirname(sessionDir);
  const projectDir = dirname(transcriptsDir);
  const sessionId = basename(sessionDir);
  const cwd =
    basename(transcriptsDir) === CURSOR_CLI_TRANSCRIPTS_SEGMENT
      ? decodeProjectDirectory(basename(projectDir))
      : null;
  return {
    cwd,
    sessionId: sessionId.length > 0 ? sessionId : null,
  };
}

/** Project directories are the cwd percent-encoded (`%2FUsers%2F…`). */
export function decodeProjectDirectory(name: string): string | null {
  if (name.length === 0) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(name);
    return decoded.startsWith('/') ? decoded : null;
  } catch {
    return null;
  }
}
