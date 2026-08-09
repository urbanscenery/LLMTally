import { installDaemon, uninstallDaemon } from '@llmtally/core/daemon/service.ts';
import { runDoctorChecks } from '@llmtally/core/doctor/checks.ts';
import type { DoctorCheck } from '@llmtally/core/doctor/checks.ts';
import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import { createActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import { captureActiveAccount, switchAccount } from '@llmtally/core/accounts/switch.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { loadAllQuota } from '@llmtally/core/quota/service.ts';
import { resetQuotaThrottle } from '@llmtally/core/quota/throttle.ts';
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
      resetQuotaThrottle();
    },

    async loadAccounts(): Promise<AccountsInput> {
      const vault = new AccountVault();
      const snapshots = await loadAllQuota({ databasePath: options.databasePath });
      return {
        snapshots,
        vault: vault.list(),
        discovered: discoverAccounts(),
        activeAccountId: vault.activeAccountId(),
      };
    },

    async addCurrentAccount(): Promise<string> {
      const entry = captureActiveAccount({
        vault: new AccountVault(),
        activeStore: createActiveCredentialStore(),
      });
      return `stored ${entry.email ?? entry.accountId} (${entry.backend})`;
    },

    async removeAccount(accountId: string): Promise<string> {
      const vault = new AccountVault();
      const entry = vault.get(accountId);
      vault.remove(accountId);
      return `removed ${entry?.email ?? accountId} from the vault`;
    },

    async switchToAccount(accountId: string): Promise<string> {
      const result = await switchAccount(accountId, {
        vault: new AccountVault(),
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
