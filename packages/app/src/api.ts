/**
 * Sidecar method surface — thin bindings from JSON-RPC methods to
 * @llmtally/core, mirroring the TUI's data-source so both surfaces read
 * the same domain truth. Handlers return plain domain objects; all
 * presentation (attention ranking, labels, formatting) stays in the
 * Swift shell. The sidecar never opens the ledger itself: it carries
 * `databasePath` and lets core services open and close it.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { resolveActiveClaudeContext } from '@llmtally/core/accounts/active-claude.ts';
import { detachCodexLogin, switchCodexAccount } from '@llmtally/core/accounts/codex.ts';
import { createActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import { switchOpencodeAccount } from '@llmtally/core/accounts/opencode.ts';
import { switchAccount as switchClaudeAccount } from '@llmtally/core/accounts/switch.ts';
import { AccountVault } from '@llmtally/core/accounts/vault.ts';
import { defaultGrokAuthPath, readGrokIdentities } from '@llmtally/core/accounts/grok.ts';
import { defaultOpencodeAuthPath, opencodeAccountId, readOpencodeProviders } from '@llmtally/core/accounts/opencode.ts';
import { defaultAntigravityStoreDir, resolveActiveAccount } from '@llmtally/core/quota/antigravity.ts';
import { readCodexAuth } from '@llmtally/core/quota/codex-live.ts';
import { dedupeByAccount, loadAllQuota } from '@llmtally/core/quota/service.ts';
import { softResetQuotaThrottle } from '@llmtally/core/quota/throttle.ts';
import { PROMPTS_DEFAULT_LIMIT, listPrompts } from '@llmtally/core/report/prompts.ts';
import { buildReportRange } from '@llmtally/core/report/range.ts';
import { generateReport } from '@llmtally/core/report/service.ts';
import { createDefaultCoordinator } from '@llmtally/core/scan/coordinator.ts';

import type { ActiveCredentialStore } from '@llmtally/core/accounts/credentials.ts';
import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import type { ReportGroupBy, ReportSummary } from '@llmtally/core/report/types.ts';
import type { ScanCoordinator } from '@llmtally/core/scan/types.ts';
import type { RpcServer } from './rpc.ts';

/** Agents whose credential switch transactions exist in core today. */
const SWITCHABLE_AGENTS = new Set(['claude-code', 'codex', 'opencode']);

export interface SidecarOptions {
  readonly databasePath: string;
  /** Test seams; production uses the defaults. */
  readonly coordinator?: ScanCoordinator;
  readonly quotaLoader?: (options: { readonly allowRefresh: boolean }) => Promise<QuotaSnapshot[]>;
  readonly vaultDir?: string;
  readonly claudeConfigPath?: string;
  readonly codexAuthPath?: string;
  readonly opencodeAuthPath?: string;
  readonly grokAuthPath?: string;
  readonly antigravityStoreDir?: string;
}

/** Every ledger agent, whether or not it has a switch transaction. */
const ALL_AGENTS = ['claude-code', 'codex', 'antigravity', 'opencode', 'cline', 'grok'] as const;

export function registerSidecarMethods(server: RpcServer, options: SidecarOptions): void {
  const databasePath = options.databasePath;

  // Lazy so that methods which never touch credentials (ping, scan,
  // report) do not create vault state as a side effect of startup.
  let vault: AccountVault | null = null;
  let activeStore: ActiveCredentialStore | null = null;
  let coordinator: ScanCoordinator | null = options.coordinator ?? null;
  const getVault = (): AccountVault =>
    (vault ??= new AccountVault(options.vaultDir === undefined ? {} : { dir: options.vaultDir }));
  const getActiveStore = (): ActiveCredentialStore => (activeStore ??= createActiveCredentialStore());
  const getCoordinator = (): ScanCoordinator => (coordinator ??= createDefaultCoordinator());

  const loadQuota =
    options.quotaLoader ??
    (async ({ allowRefresh }: { readonly allowRefresh: boolean }): Promise<QuotaSnapshot[]> => {
      const activeContext = resolveActiveClaudeContext({ vault: getVault() });
      const snapshots = await loadAllQuota({
        databasePath,
        vault: getVault(),
        activeContext,
        allowRefresh,
      });
      return dedupeByAccount(snapshots);
    });

  server.register('ping', () => ({ ok: true, databasePath }));

  server.register('scan', () =>
    getCoordinator().run({ agent: null, fullRescan: false, databasePath }));

  server.register('quota', (params) =>
    loadQuota({ allowRefresh: readBool(params, 'refresh') ?? true }));

  server.register('report', (params) => reportFor(params, databasePath));

  server.register('overview', async (params) => {
    const [quota, report] = await Promise.all([
      loadQuota({ allowRefresh: readBool(params, 'refresh') ?? true }),
      reportFor({ groupBy: 'day' }, databasePath),
    ]);
    return { quota, report };
  });

  server.register('prompts', (params) =>
    listPrompts({
      databasePath,
      agent: readString(params, 'agent'),
      model: readString(params, 'model'),
      search: readString(params, 'search'),
      limit: readNumber(params, 'limit') ?? PROMPTS_DEFAULT_LIMIT,
    }));

  server.register('accounts', () => discoverAccounts());

  server.register('activeAccounts', () => {
    // Which account each agent is logged into right now. Claude's truth
    // is the runtime config (not a vault marker); codex's is its live
    // auth.json — the vault marker only exists after a switch through
    // llmtally and can go stale when codex logs in on its own. The
    // rest come from the vault's per-agent active map.
    const context = resolveActiveClaudeContext({
      vault: getVault(),
      ...(options.claudeConfigPath === undefined ? {} : { configPath: options.claudeConfigPath }),
    });
    const active: Record<string, string | null> = {};
    for (const agent of ALL_AGENTS) {
      active[agent] = agent === 'claude-code'
        ? context.activeAccountId
        : getVault().activeAccountId(agent);
    }
    const liveCodex = readCodexAuth(options.codexAuthPath)?.accountId ?? null;
    if (liveCodex !== null) {
      active['codex'] = liveCodex;
    }
    // the same rule for every agent with a live store: the file the
    // agent itself maintains beats a vault marker that only exists
    // after an llmtally switch (audit C1-03)
    const liveOpencode = readLiveOpencodeId(options.opencodeAuthPath ?? defaultOpencodeAuthPath());
    if (liveOpencode !== null) {
      active['opencode'] = liveOpencode;
    }
    try {
      const antigravity = resolveActiveAccount(
        options.antigravityStoreDir ?? defaultAntigravityStoreDir(),
      );
      if (antigravity !== null) {
        active['antigravity'] = antigravity.email;
      }
    } catch {
      // no antigravity store is the common case, not an error
    }
    const grokIdentities = readGrokIdentities(options.grokAuthPath ?? defaultGrokAuthPath(homedir()));
    if (grokIdentities.length === 1) {
      // two simultaneous logins are ambiguous — show none rather than guess
      active['grok'] = grokIdentities[0]?.accountId ?? null;
    }
    return active;
  });

  server.register('switchAccount', (params) => {
    const agent = requireString(params, 'agent');
    const selector = requireString(params, 'selector');
    if (!SWITCHABLE_AGENTS.has(agent)) {
      throw new Error(`switch is not supported for agent: ${agent}`);
    }
    if (agent === 'codex') {
      return switchCodexAccount(selector, { vault: getVault() });
    }
    if (agent === 'opencode') {
      return switchOpencodeAccount(selector, { vault: getVault() });
    }
    return switchClaudeAccount(selector, { vault: getVault(), activeStore: getActiveStore() });
  });

  server.register('detachCodex', () => {
    // Destructive (deletes ~/.codex/auth.json after a verified vault
    // capture — core aborts on any byte mismatch). The shell gates
    // this behind an explicit confirmation dialog in Settings.
    return detachCodexLogin({ vault: getVault() });
  });

  server.register('todayByAgent', async () => {
    // ledger activity for the agent_active status metric: which agents
    // have rows today (local calendar day, ledger only, no refresh)
    const today = localDayKey();
    const range = buildReportRange(today, today);
    if ('error' in range) {
      throw new Error(range.error);
    }
    const summary = await generateReport({
      databasePath,
      groupBy: 'agent',
      agent: null,
      range,
      noRefresh: true,
    });
    return Object.fromEntries(summary.buckets.map((bucket) => [bucket.key, bucket.rowCount]));
  });

  server.register('invalidateQuotaCache', () => {
    // Only the soft reset: 429 backoff and the shared fetch budget stay
    // intact so a refresh-happy user cannot re-burn a refused budget.
    softResetQuotaThrottle();
    return { ok: true };
  });
}

const REPORT_GROUP_BYS: readonly ReportGroupBy[] = ['day', 'hour', 'model', 'agent'];

async function reportFor(params: unknown, databasePath: string): Promise<ReportSummary> {
  const raw = readString(params, 'groupBy') ?? 'day';
  // validate at the boundary: an unknown groupBy must be an input
  // error, not an internal SQL failure (audit codex C1-09)
  const groupBy = REPORT_GROUP_BYS.find((candidate) => candidate === raw);
  if (groupBy === undefined) {
    throw new Error(`unknown groupBy: ${raw} (expected ${REPORT_GROUP_BYS.join(', ')})`);
  }
  const range = buildReportRange(readString(params, 'fromDate'), readString(params, 'toDate'));
  if ('error' in range) {
    throw new Error(range.error);
  }
  return generateReport({
    databasePath,
    groupBy,
    agent: readString(params, 'agent'),
    range,
    noRefresh: readBool(params, 'noRefresh') ?? false,
  });
}

/** Local calendar day, matching the report layer's local bucketing. */
function localDayKey(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function readString(params: unknown, key: string): string | null {
  const value = asRecord(params)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readBool(params: unknown, key: string): boolean | null {
  const value = asRecord(params)[key];
  return typeof value === 'boolean' ? value : null;
}

function readNumber(params: unknown, key: string): number | null {
  const value = asRecord(params)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireString(params: unknown, key: string): string {
  const value = readString(params, key);
  if (value === null) {
    throw new Error(`${key} is required`);
  }
  return value;
}

/** Derived id of the live opencode credential set; null when none. */
function readLiveOpencodeId(authPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(authPath, 'utf8');
  } catch {
    return null;
  }
  return readOpencodeProviders(text).length > 0 ? opencodeAccountId(text) : null;
}
