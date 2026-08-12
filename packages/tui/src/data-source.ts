import { readFileSync } from 'node:fs';

import { installDaemon, uninstallDaemon } from '@llmtally/core/daemon/service.ts';
import { runDoctorChecks } from '@llmtally/core/doctor/checks.ts';
import type { DoctorCheck } from '@llmtally/core/doctor/checks.ts';
import { resolveActiveClaudeContext } from '@llmtally/core/accounts/active-claude.ts';
import { captureCodexAccount, switchCodexAccount } from '@llmtally/core/accounts/codex.ts';
import {
  captureOpencodeAccount,
  defaultOpencodeAuthPath,
  opencodeAccountId,
  switchOpencodeAccount,
} from '@llmtally/core/accounts/opencode.ts';
import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import { createActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import { captureActiveAccount, switchAccount } from '@llmtally/core/accounts/switch.ts';
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
  /** Account mutations; each resolves to a line to show the user. */
  addCurrentAccount(): Promise<string>;
  removeAccount(accountId: string): Promise<string>;
  switchToAccount(accountId: string): Promise<string>;
}

/** Identity of the live opencode credential set; null when none. */
function readLiveOpencodeId(): string | null {
  try {
    const text = readFileSync(defaultOpencodeAuthPath(), 'utf8');
    return text.length === 0 ? null : opencodeAccountId(text);
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

    async removeAccount(accountId: string): Promise<string> {
      const vault = new AccountVault();
      const entry = vault.get(accountId);
      vault.remove(accountId);
      return `removed ${entry?.email ?? accountId} from the vault`;
    },

    async switchToAccount(accountId: string): Promise<string> {
      // the vault entry knows which agent owns this account; each agent
      // has its own switch mechanics
      const vault = new AccountVault();
      const agent = vault.get(accountId)?.agent ?? 'claude-code';
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
      const result = await switchAccount(accountId, {
        vault,
        activeStore: createActiveCredentialStore(),
      });
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
      const result = installDaemon({ ledgerPath: options.databasePath, allowDevCheckout: true });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.message;
    },

    async uninstallDaemon(): Promise<string> {
      return uninstallDaemon().message;
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
