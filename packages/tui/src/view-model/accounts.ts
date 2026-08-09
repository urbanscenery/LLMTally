import type { AccountProfile } from '@llmtally/core/accounts/discovery.ts';
import type { VaultEntry } from '@llmtally/core/accounts/vault.ts';
import type { QuotaSnapshot, QuotaSource } from '@llmtally/core/quota/providers.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';

export interface QuotaBarViewModel {
  readonly id: string;
  /** Raw observed value; may legitimately exceed 100. */
  readonly usedPercent: number;
  /** Clamped 0..1 fill used only for gauge geometry. */
  readonly fillRatio: number;
  readonly resetsAtUtc: number | null;
}

export interface QuotaProviderViewModel {
  readonly agent: string;
  readonly account: string | null;
  readonly plan: string | null;
  readonly source: QuotaSource;
  readonly observedAtUtc: number;
  readonly bars: readonly QuotaBarViewModel[];
  readonly warnings: readonly string[];
}

/** One switchable-or-not account, with whatever quota we know for it. */
export interface AccountRowViewModel {
  readonly agent: string;
  readonly label: string;
  /** Vault id when the account can be restored, else null. */
  readonly accountId: string | null;
  readonly isActive: boolean;
  readonly quota: QuotaProviderViewModel | null;
  /** Why this row exists when there is no quota reading. */
  readonly note: string | null;
}

export interface AccountsTabViewModel {
  readonly rows: readonly AccountRowViewModel[];
  /** Agents whose accounts llmtally can switch between. */
  readonly switchableAgents: readonly string[];
}

export interface AccountsInput {
  readonly snapshots: readonly QuotaSnapshot[];
  readonly vault: readonly VaultEntry[];
  readonly discovered: readonly AccountProfile[];
  readonly activeAccountId: string | null;
}

export const SWITCHABLE_AGENTS: readonly string[] = ['claude-code'];

function toProvider(snapshot: QuotaSnapshot): QuotaProviderViewModel {
  return {
    agent: sanitizeTerminalLine(snapshot.agent),
    account: snapshot.account === null ? null : sanitizeTerminalLine(snapshot.account),
    plan: snapshot.plan === null ? null : sanitizeTerminalLine(snapshot.plan),
    source: snapshot.source,
    observedAtUtc: snapshot.observedAtUtc,
    bars: snapshot.windows
      .filter((window) => Number.isFinite(window.usedPercent))
      .map((window) => ({
        id: sanitizeTerminalLine(window.id),
        usedPercent: window.usedPercent,
        fillRatio: Math.min(1, Math.max(0, window.usedPercent / 100)),
        resetsAtUtc: window.resetsAtUtc,
      })),
    warnings: snapshot.warnings.map((warning) => sanitizeTerminalLine(warning)),
  };
}

/**
 * Account labels differ per source: quota rows carry an email (with an
 * optional ` [alias]` suffix), the vault carries an id plus an email.
 * Matching on the email prefix is what lets a quota reading and its
 * stored credentials appear as one row.
 */
function sameAccount(label: string | null, entry: VaultEntry): boolean {
  if (label === null) {
    return false;
  }
  if (label === entry.accountId) {
    return true;
  }
  const email = entry.email;
  return email !== null && (label === email || label.startsWith(`${email} `));
}

/**
 * Quota readings first (they carry the most information), then stored
 * accounts we have no reading for, then anything discovery found that
 * neither covered — so nothing the user has is silently missing.
 */
export function toAccountsTabViewModel(input: AccountsInput): AccountsTabViewModel {
  const rows: AccountRowViewModel[] = [];
  const claimedVault = new Set<string>();

  for (const snapshot of input.snapshots) {
    const provider = toProvider(snapshot);
    // an email can legitimately belong to two accounts (personal and
    // organization); binding a quota row to the wrong one would let the
    // user switch or remove an account they did not select
    const matches = input.vault.filter(
      (candidate) => candidate.agent === snapshot.agent && sameAccount(provider.account, candidate),
    );
    const entry =
      matches.length === 1
        ? matches[0]
        : matches.find((candidate) => candidate.accountId === input.activeAccountId);
    if (entry !== undefined) {
      claimedVault.add(entry.accountId);
    }
    rows.push({
      agent: provider.agent,
      label: provider.account ?? '(current login)',
      accountId: entry?.accountId ?? null,
      isActive: entry !== undefined && entry.accountId === input.activeAccountId,
      quota: provider,
      note:
        entry === undefined && matches.length > 1
          ? `${matches.length} stored accounts share this address — use "llmtally switch <id>"`
          : null,
    });
  }

  for (const entry of input.vault) {
    if (claimedVault.has(entry.accountId)) {
      continue;
    }
    rows.push({
      agent: sanitizeTerminalLine(entry.agent),
      label: sanitizeTerminalLine(
        (entry.email ?? entry.accountId) + (entry.alias === null ? '' : ` [${entry.alias}]`),
      ),
      accountId: entry.accountId,
      isActive: entry.accountId === input.activeAccountId,
      quota: null,
      note: 'stored; no quota reading',
    });
  }

  const covered = new Set(rows.map((row) => `${row.agent} ${row.label}`));
  for (const profile of input.discovered) {
    const label = sanitizeTerminalLine(profile.displayLabel);
    const agent = sanitizeTerminalLine(profile.agent);
    if (covered.has(`${agent} ${label}`)) {
      continue;
    }
    covered.add(`${agent} ${label}`);
    rows.push({
      agent,
      label,
      accountId: null,
      isActive: false,
      quota: null,
      note: `discovered via ${sanitizeTerminalLine(profile.discoveredVia)}`,
    });
  }

  return { rows, switchableAgents: SWITCHABLE_AGENTS };
}

export function isSwitchable(row: AccountRowViewModel): boolean {
  return row.accountId !== null && SWITCHABLE_AGENTS.includes(row.agent);
}
