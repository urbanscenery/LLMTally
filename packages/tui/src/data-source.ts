import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { installDaemon, uninstallDaemon } from '@llmtally/core/daemon/service.ts';
import { compactLedger } from '@llmtally/core/db/maintenance.ts';
import { runDoctorChecks } from '@llmtally/core/doctor/checks.ts';
import type { DoctorCheck } from '@llmtally/core/doctor/checks.ts';
import { resolveActiveClaudeContext } from '@llmtally/core/accounts/active-claude.ts';
import {
  captureCodexAccount,
  detachCodexLogin,
  switchCodexAccount,
} from '@llmtally/core/accounts/codex.ts';
import {
  captureOpencodeAccount,
  defaultOpencodeAuthPath,
  opencodeAccountId,
  readOpencodeProviders,
  switchOpencodeAccount,
} from '@llmtally/core/accounts/opencode.ts';
import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import { defaultGrokAuthPath, readGrokIdentities } from '@llmtally/core/accounts/grok.ts';
import { createActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import { captureActiveAccount, switchAccount } from '@llmtally/core/accounts/switch.ts';
import {
  assertSwitchCooldown,
  defaultSwitchCooldownPath,
  recordSwitchCooldown,
} from '@llmtally/core/accounts/switch-cooldown.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { defaultAntigravityStoreDir, resolveActiveAccount } from '@llmtally/core/quota/antigravity.ts';
import { readCodexAuth } from '@llmtally/core/quota/codex-live.ts';
import { loadAllQuota } from '@llmtally/core/quota/service.ts';
import { softResetQuotaThrottle } from '@llmtally/core/quota/throttle.ts';
import { PROMPTS_DEFAULT_LIMIT, listPrompts } from '@llmtally/core/report/prompts.ts';
import type { PromptListResult } from '@llmtally/core/report/prompts.ts';
import { generateReport } from '@llmtally/core/report/service.ts';
import type { ReportGroupBy, ReportSummary } from '@llmtally/core/report/types.ts';
import { createDefaultCoordinator } from '@llmtally/core/scan/coordinator.ts';
import type { ScanCoordinator, ScanSummary } from '@llmtally/core/scan/types.ts';
import type { AccountsInput } from './view-model/accounts.ts';

/**
 * Ports the TUI uses to reach domain services; injected as fakes in
 * tests. The TUI never opens the ledger or touches providers directly.
 */
export interface TuiDataSource {
  scan(): Promise<ScanSummary>;
  loadAccounts(): Promise<AccountsInput>;
  /** Drops the quota cache so the next read hits the vendors. */
  invalidateQuotaCache(): void;
  loadReport(groupBy: ReportGroupBy): Promise<ReportSummary>;
  loadDoctorChecks(): Promise<readonly DoctorCheck[]>;
  loadPrompts(filter: { model: string | null; search: string | null }): Promise<PromptListResult>;
  installDaemon(): Promise<string>;
  uninstallDaemon(): Promise<string>;
  /** VACUUMs the ledger under the scan lock; resolves to a size report. */
  compactLedger(): Promise<string>;
  /** Account mutations; each resolves to a line to show the user. */
  addCurrentAccount(): Promise<string>;
  removeAccount(agent: string, accountId: string): Promise<string>;
  switchToAccount(agent: string, accountId: string): Promise<string>;
  /** Stores the live codex login, then signs codex out without revoking. */
  detachCodexAccount(): Promise<string>;
}

/** The one live grok identity; null when none or ambiguous. */
function singleGrokIdentity(): string | null {
  const identities = readGrokIdentities(defaultGrokAuthPath(homedir()));
  return identities.length === 1 ? (identities[0]?.accountId ?? null) : null;
}

function readLiveOpencodeId(): string | null {
  try {
    const text = readFileSync(defaultOpencodeAuthPath(), 'utf8');
    // parity with the sidecar (audit grok C3-09): an auth file with no
    // usable providers is "logged out", not a synthetic '.xxxxxx' id
    if (text.length === 0 || readOpencodeProviders(text).length === 0) {
      return null;
    }
    return opencodeAccountId(text);
  } catch {
    return null;
  }
}

export interface DefaultDataSourceOptions {
  readonly databasePath: string;
  readonly coordinator?: ScanCoordinator;
}

export function createDefaultDataSource(options: DefaultDataSourceOptions): TuiDataSource {
  const coordinator = options.coordinator ?? createDefaultCoordinator();
  return {
    async scan(): Promise<ScanSummary> {
      return coordinator.run({
        agent: null,
        fullRescan: false,
        databasePath: options.databasePath,
      });
    },
    invalidateQuotaCache(): void {
      // freshness only: the 429 backoff and the shared cadence survive,
      // so hammering r cannot spend budget the endpoint already refused
      softResetQuotaThrottle();
    },

    async loadAccounts(): Promise<AccountsInput> {
      const vault = new AccountVault();
      // resolved once and passed everywhere: the live login (not the
      // registry marker) decides which account is active
      const context = resolveActiveClaudeContext({ vault });
      const snapshots = await loadAllQuota({
        databasePath: options.databasePath,
        vault,
        activeContext: context,
      });
      return {
        snapshots,
        vault: vault.list(),
        discovered: discoverAccounts(),
        activeAccountId: context.activeAccountId,
        // non-claude agents derive "active" from their own stores
        activeByAgent: {
          codex: readCodexAuth()?.accountId ?? null,
          antigravity: resolveActiveAccount(defaultAntigravityStoreDir())?.email ?? null,
          opencode: readLiveOpencodeId(),
          // one live grok identity is unambiguous; two logins at once
          // means nobody can say which is "active" — show none
          grok: singleGrokIdentity(),
        },
      };
    },

    async addCurrentAccount(): Promise<string> {
      // capture whatever is logged in right now, per agent; an agent
      // without a login is simply skipped, not an error — but at least
      // one login must exist for the action to have done anything
      const vault = new AccountVault();
      const stored: string[] = [];
      const skipped: string[] = [];
      try {
        const entry = captureActiveAccount({
          vault,
          activeStore: createActiveCredentialStore(),
        });
        stored.push(`${entry.email ?? entry.accountId} (claude-code)`);
      } catch (error) {
        skipped.push(`claude-code: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const entry = captureCodexAccount({ vault });
        stored.push(`${entry.email ?? entry.accountId} (codex)`);
      } catch (error) {
        skipped.push(`codex: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const entry = captureOpencodeAccount({ vault });
        stored.push(`${entry.accountId} (opencode)`);
      } catch (error) {
        skipped.push(`opencode: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stored.length === 0) {
        throw new Error(skipped.join('\n'));
      }
      return [`stored ${stored.join(', ')}`, ...skipped].join('\n');
    },

    async detachCodexAccount(): Promise<string> {
      const result = detachCodexLogin({ vault: new AccountVault() });
      return [
        `stored ${result.entry.email ?? result.entry.accountId} and signed codex out locally`,
        ...result.warnings,
      ].join('\n');
    },

    async removeAccount(agent: string, accountId: string): Promise<string> {
      const vault = new AccountVault();
      const entry = vault.get(agent, accountId);
      vault.remove(agent, accountId);
      return `removed ${entry?.email ?? accountId} from the vault`;
    },

    async switchToAccount(agent: string, accountId: string): Promise<string> {
      // each agent has its own switch mechanics
      const vault = new AccountVault();
      if (agent === 'codex') {
        const result = await switchCodexAccount(accountId, { vault });
        return [
          `switched codex to ${result.target.email ?? result.target.accountId}`,
          ...result.warnings,
        ].join('\n');
      }
      if (agent === 'opencode') {
        const result = await switchOpencodeAccount(accountId, { vault });
        return [
          `switched opencode to ${result.target.alias ?? result.target.accountId}`,
          ...result.warnings,
        ].join('\n');
      }
      if (agent !== 'claude-code') {
        // never fall through to the Claude switch for an agent whose
        // switch mechanics do not exist — a same-named Claude account
        // could be moved instead (audit GK-26)
        throw new Error(`switch is not supported for agent: ${agent}`);
      }
      // settle window shared with the menu bar app: the Keychain read
      // is cached ~30s by Claude Code, so back-to-back switches act on
      // stores that are still converging
      const cooldownPath = defaultSwitchCooldownPath();
      assertSwitchCooldown(cooldownPath);
      const result = await switchAccount(accountId, {
        vault,
        activeStore: createActiveCredentialStore(),
      });
      recordSwitchCooldown(cooldownPath);
      const sessions =
        result.liveSessions.length === 0
          ? ''
          : `\n${result.liveSessions.length} Claude Code session(s) are running`;
      const propagation =
        result.backend === 'keychain'
          ? 'a running session picks this up within ~30s'
          : 'a running session picks this up on its next message';
      return `switched to ${result.target.email ?? result.target.accountId}\n${propagation}${sessions}`;
    },
    async loadPrompts(filter: {
      model: string | null;
      search: string | null;
    }): Promise<PromptListResult> {
      return listPrompts({
        databasePath: options.databasePath,
        model: filter.model,
        agent: null,
        search: filter.search,
        limit: PROMPTS_DEFAULT_LIMIT,
      });
    },

    async loadDoctorChecks(): Promise<readonly DoctorCheck[]> {
      return runDoctorChecks({ databasePath: options.databasePath });
    },

    async installDaemon(): Promise<string> {
      // a dev checkout's absolute worker path in the plist becomes an
      // hourly crash loop the moment the tree moves (audit GK-10) —
      // opt in explicitly instead of always allowing it
      const result = installDaemon({
        ledgerPath: options.databasePath,
        allowDevCheckout: process.env.LLMTALLY_ALLOW_DEV_DAEMON === '1',
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.message;
    },

    async uninstallDaemon(): Promise<string> {
      return uninstallDaemon().message;
    },

    async compactLedger(): Promise<string> {
      const result = compactLedger(options.databasePath);
      const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;
      return `compacted ${megabytes(result.beforeBytes)} → ${megabytes(result.afterBytes)} (reclaimed ${megabytes(result.reclaimedBytes)})`;
    },

    async loadReport(groupBy: ReportGroupBy): Promise<ReportSummary> {
      return generateReport({
        databasePath: options.databasePath,
        groupBy,
        agent: null,
        range: { fromDate: null, toDate: null },
        noRefresh: false,
      });
    },
  };
}
