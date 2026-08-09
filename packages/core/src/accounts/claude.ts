/**
 * Read-only Claude Code account identity. `~/.claude.json` (or
 * `$CLAUDE_CONFIG_DIR/.claude.json`) carries the currently logged-in
 * account under `oauthAccount`; per confirmed policy this is used for
 * account discovery and quota labeling only — never for attributing
 * past ledger rows (backfill is forbidden).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';

export interface ClaudeActiveIdentity {
  readonly accountUuid: string | null;
  readonly email: string | null;
  readonly organizationUuid: string | null;
  readonly organizationName: string | null;
}

export function defaultClaudeConfigPath(home: string = homedir()): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const base = configDir !== undefined && configDir.startsWith('/') ? configDir : home;
  return join(base, '.claude.json');
}

export function readClaudeActiveIdentity(
  configPath: string = defaultClaudeConfigPath(),
): ClaudeActiveIdentity | null {
  let oauth: Record<string, unknown> | null;
  try {
    const parsed = asObject(JSON.parse(readFileSync(configPath, 'utf8')));
    oauth = parsed === null ? null : asObject(parsed.oauthAccount);
  } catch {
    return null;
  }
  if (oauth === null) {
    return null;
  }
  return {
    accountUuid: asString(oauth.accountUuid),
    email: asString(oauth.emailAddress),
    organizationUuid: asString(oauth.organizationUuid),
    organizationName: asString(oauth.organizationName),
  };
}
