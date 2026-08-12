/**
 * Single source of truth for "which Claude account is active". The
 * answer lives in `~/.claude.json` (`oauthAccount`) — Claude Code and
 * every other switcher update it — while llmtally's vault registry
 * marker only records the last switch *we* performed. The marker
 * therefore goes stale whenever the login changes elsewhere, so it is
 * demoted to a fallback for the one case the config cannot answer
 * (unreadable), and silently re-synced otherwise.
 *
 * Callers resolve the context once per operation and pass it down;
 * re-reading it mid-operation could observe a switch in progress.
 */
import { readClaudeActiveIdentityState } from './claude.ts';
import type { ClaudeActiveIdentity } from './claude.ts';
import type { AccountVault } from './vault.ts';

export type ActiveClaudeContext =
  | {
      readonly status: 'identified';
      readonly source: 'claude_config';
      readonly activeAccountId: string;
      readonly identity: ClaudeActiveIdentity & { readonly accountUuid: string };
    }
  | {
      readonly status: 'signed_out';
      readonly source: 'none';
      readonly activeAccountId: null;
      readonly identity: null;
    }
  | {
      readonly status: 'unreadable';
      readonly source: 'vault_fallback';
      readonly activeAccountId: string | null;
      readonly identity: null;
    };

/**
 * Reads the live identity exactly once and reconciles the registry
 * marker with it. Marker writes are best-effort: quota display must
 * not fail because a registry file was briefly unwritable.
 */
export function resolveActiveClaudeContext(options: {
  readonly vault: AccountVault;
  readonly configPath?: string;
}): ActiveClaudeContext {
  const state =
    options.configPath === undefined
      ? readClaudeActiveIdentityState()
      : readClaudeActiveIdentityState(options.configPath);

  if (state.status === 'identified') {
    const accountUuid = state.identity.accountUuid;
    try {
      if (options.vault.activeAccountId('claude-code') !== accountUuid) {
        // wait 0: a held lock skips the sync rather than stalling a poll
        options.vault.setActive('claude-code', accountUuid, 0);
      }
    } catch {
      // the context already carries the truth; the marker catches up later
    }
    return {
      status: 'identified',
      source: 'claude_config',
      activeAccountId: accountUuid,
      identity: state.identity,
    };
  }

  if (state.status === 'signed_out') {
    try {
      if (options.vault.activeAccountId('claude-code') !== null) {
        options.vault.setActive('claude-code', null, 0);
      }
    } catch {
      // same best-effort rule as above
    }
    return { status: 'signed_out', source: 'none', activeAccountId: null, identity: null };
  }

  let marker: string | null = null;
  try {
    marker = options.vault.activeAccountId('claude-code');
  } catch {
    marker = null;
  }
  return {
    status: 'unreadable',
    source: 'vault_fallback',
    activeAccountId: marker,
    identity: null,
  };
}

/**
 * Mirroring the live credential into the vault — and the quarantine
 * lift that rides along with it — lives in `live-sync.ts`.
 */
