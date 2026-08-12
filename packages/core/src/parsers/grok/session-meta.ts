import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { asObject, asString } from '../shared.ts';
import { GROK_SUMMARY_FILE } from './constants.ts';

export interface GrokSessionMeta {
  readonly cwd: string | null;
  /**
   * Session-level setting. Grok records reasoning effort per assistant
   * message in chat_history.jsonl only; updates.jsonl carries none, so a
   * mid-session change is reflected from the next scan onward and already
   * committed rows keep the effort they were written with.
   */
  readonly effort: string | null;
  readonly sessionId: string | null;
}

/**
 * Session context for one updates.jsonl. The stream has no header record,
 * so this must be recoverable from the path alone: a resumed scan starts
 * at a byte offset and never replays the beginning of the file.
 */
export function readGrokSessionMeta(updatesPath: string): GrokSessionMeta {
  const sessionDir = dirname(updatesPath);
  const fallback: GrokSessionMeta = {
    cwd: decodeProjectDirectory(basename(dirname(sessionDir))),
    effort: null,
    sessionId: basename(sessionDir),
  };
  let summary: Record<string, unknown> | null;
  try {
    summary = asObject(JSON.parse(readFileSync(join(sessionDir, GROK_SUMMARY_FILE), 'utf8')));
  } catch {
    return fallback;
  }
  if (summary === null) {
    return fallback;
  }
  const info = asObject(summary.info);
  return {
    cwd: asString(info?.cwd ?? null) ?? fallback.cwd,
    effort: asString(summary.reasoning_effort),
    sessionId: asString(info?.id ?? null) ?? fallback.sessionId,
  };
}

/** Project directories are the cwd percent-encoded (`%2FUsers%2F…`). */
function decodeProjectDirectory(name: string): string | null {
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
