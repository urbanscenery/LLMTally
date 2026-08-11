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

/**
 * The three states a config read can land in — they drive different
 * fallbacks. `signed_out` (readable file, no account) must never fall
 * back to a stored marker: trusting one would resurrect a login that
 * was deliberately ended. Only `unreadable` (missing/corrupt file, or a
 * shape we cannot interpret) justifies falling back.
 */
export type ClaudeIdentityReadResult =
  | {
      readonly status: 'identified';
      readonly identity: ClaudeActiveIdentity & { readonly accountUuid: string };
    }
  | { readonly status: 'signed_out'; readonly identity: null }
  | { readonly status: 'unreadable'; readonly identity: null };

export function readClaudeActiveIdentityState(
  configPath: string = defaultClaudeConfigPath(),
): ClaudeIdentityReadResult {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asObject(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return { status: 'unreadable', identity: null };
  }
  if (parsed === null) {
    return { status: 'unreadable', identity: null };
  }
  if (!('oauthAccount' in parsed) || parsed.oauthAccount === null) {
    return { status: 'signed_out', identity: null };
  }
  const oauth = asObject(parsed.oauthAccount);
  const accountUuid = oauth === null ? null : asString(oauth.accountUuid)?.trim() || null;
  if (oauth === null || accountUuid === null) {
    // an oauthAccount we cannot name is indistinguishable from damage
    return { status: 'unreadable', identity: null };
  }
  return {
    status: 'identified',
    identity: {
      accountUuid,
      email: asString(oauth.emailAddress),
      organizationUuid: asString(oauth.organizationUuid),
      organizationName: asString(oauth.organizationName),
    },
  };
}

export function readClaudeActiveIdentity(
  configPath: string = defaultClaudeConfigPath(),
): ClaudeActiveIdentity | null {
  return readClaudeActiveIdentityState(configPath).identity;
}
