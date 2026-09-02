import type { AccountProfile } from '@llmtally/core/accounts/discovery.ts';
import type { VaultEntry } from '@llmtally/core/accounts/vault.ts';
import type { QuotaFailure, QuotaSnapshot, QuotaSource } from '@llmtally/core/quota/providers.ts';
import { compareWindows, normalizeQuotaWindow } from '@llmtally/core/quota/window-policy.ts';
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
  /** Stable vendor account id; the binding/active key when present. */
  readonly accountId: string | null;
  readonly account: string | null;
  readonly plan: string | null;
  readonly source: QuotaSource;
  readonly observedAtUtc: number;
  /** Why the latest read failed; null when the reading is fresh. */
  readonly failure: QuotaFailure | null;
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
  /**
   * The stored refresh lineage was rejected by the token endpoint —
   * switching to it would install dead credentials. Recovers on the
   * next login as this account (auto re-capture). Must be loudly
   * visible: the row's numbers may look fine while its login is dead.
   */
  readonly refreshDead: boolean;
  readonly quota: QuotaProviderViewModel | null;
  /** Why this row exists when there is no quota reading. */
  readonly note: string | null;
}

/**
 * One agent's accounts, drawn as a block. The agent IS the switching
 * boundary — `s` only ever moves between logins of the same agent — so
 * grouping by it puts the accounts that compete for one slot next to
 * each other, and lets the block say "switchable" once instead of every
 * row repeating it.
 */
export interface AccountGroupViewModel {
  readonly agent: string;
  readonly switchable: boolean;
  /** Accounts whose stored login is dead and needs a fresh sign-in. */
  readonly needsReloginCount: number;
  readonly rows: readonly AccountRowViewModel[];
}

export interface AccountsTabViewModel {
  /** Flattened `groups`, in display order: the cursor indexes this. */
  readonly rows: readonly AccountRowViewModel[];
  readonly groups: readonly AccountGroupViewModel[];
  /** Agents whose accounts llmtally can switch between. */
  readonly switchableAgents: readonly string[];
}

export interface AccountsInput {
  readonly snapshots: readonly QuotaSnapshot[];
  readonly vault: readonly VaultEntry[];
  readonly discovered: readonly AccountProfile[];
  /** The active claude-code account (live login, not the vault marker). */
  readonly activeAccountId: string | null;
  /** Active account per non-claude agent (codex auth.json, antigravity store). */
  readonly activeByAgent?: Readonly<Record<string, string | null>>;
}

export const SWITCHABLE_AGENTS: readonly string[] = [
  'claude-code',
  'codex',
  'opencode',
  'grok',
  'cursor-cli',
];

/** Which account id counts as "active" for rows of this agent. */
function activeIdFor(agent: string, input: AccountsInput): string | null {
  if (agent === 'claude-code') {
    return input.activeAccountId;
  }
  return input.activeByAgent?.[agent] ?? null;
}

function toProvider(snapshot: QuotaSnapshot): QuotaProviderViewModel {
  return {
    agent: sanitizeTerminalLine(snapshot.agent),
    accountId: snapshot.accountId === null ? null : sanitizeTerminalLine(snapshot.accountId),
    account: snapshot.account === null ? null : sanitizeTerminalLine(snapshot.account),
    failure: snapshot.failure,
    plan: snapshot.plan === null ? null : sanitizeTerminalLine(snapshot.plan),
    source: snapshot.source,
    observedAtUtc: snapshot.observedAtUtc,
    bars: snapshot.windows
      .filter((window) => Number.isFinite(window.usedPercent))
      .map((window) => ({
        window,
        normalized: normalizeQuotaWindow(sanitizeTerminalLine(window.id)),
      }))
      .sort((a, b) => compareWindows(a.normalized, b.normalized))
      .map(({ window, normalized }) => ({
        id: normalized.label,
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
 * A row with no vault entry cannot be switched to. For the agents that
 * keep their whole login in one file, that is also why a second account
 * appears to vanish on re-login: `codex login` (or opencode's auth
 * write) overwrites the only copy, and nothing preserved the previous
 * one. Saying so on the row is what turns a dead end into an action.
 */
function unstoredNote(agent: string): string | null {
  return SWITCHABLE_AGENTS.includes(agent)
    ? 'not stored yet — press n to keep this login for switching'
    : null;
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
    // the stable account id binds exactly; the email fallback exists for
    // rows that never got one. An email can legitimately belong to two
    // accounts (personal and organization) — binding a quota row to the
    // wrong one would let the user switch or remove an account they did
    // not select, so ambiguity yields no binding.
    const byId =
      provider.accountId === null
        ? undefined
        : input.vault.find(
            (candidate) =>
              candidate.agent === snapshot.agent && candidate.accountId === provider.accountId,
          );
    const matches =
      byId !== undefined || provider.accountId !== null
        ? []
        : input.vault.filter(
            (candidate) =>
              candidate.agent === snapshot.agent && sameAccount(provider.account, candidate),
          );
    const activeId = activeIdFor(snapshot.agent, input);
    const entry =
      byId ??
      (matches.length === 1
        ? matches[0]
        : matches.find((candidate) => candidate.accountId === activeId));
    if (entry !== undefined) {
      // agent-qualified: two agents may store the same account id
      claimedVault.add(`${entry.agent}:${entry.accountId}`);
    }
    rows.push({
      agent: provider.agent,
      label: provider.account ?? '(current login)',
      accountId: entry?.accountId ?? null,
      // the live login is active even before it is ever stored: the id
      // on the snapshot is authoritative, the vault binding is not
      isActive:
        provider.accountId !== null
          ? provider.accountId === activeId
          : entry !== undefined && entry.accountId === activeId,
      refreshDead: entry !== undefined && entry.refreshDeadAtUtc !== null,
      quota: provider,
      note:
        entry !== undefined
          ? null
          : matches.length > 1
            ? `${matches.length} stored accounts share this address — select the one you want and press s`
            : unstoredNote(provider.agent),
    });
  }

  for (const entry of input.vault) {
    if (claimedVault.has(`${entry.agent}:${entry.accountId}`)) {
      continue;
    }
    rows.push({
      agent: sanitizeTerminalLine(entry.agent),
      label: sanitizeTerminalLine(
        (entry.email ?? entry.accountId) + (entry.alias === null ? '' : ` [${entry.alias}]`),
      ),
      accountId: entry.accountId,
      isActive: entry.accountId === activeIdFor(entry.agent, input),
      refreshDead: entry.refreshDeadAtUtc !== null,
      quota: null,
      note: 'stored; no quota reading',
    });
  }

  const covered = new Set(rows.map((row) => `${row.agent} ${row.label}`));
  const coveredIds = new Set<string>();
  for (const snapshot of input.snapshots) {
    if (snapshot.accountId !== null) {
      coveredIds.add(`${snapshot.agent}:${snapshot.accountId}`);
    }
  }
  for (const row of rows) {
    if (row.accountId !== null) {
      coveredIds.add(`${row.agent}:${row.accountId}`);
    }
  }
  for (const profile of input.discovered) {
    const label = sanitizeTerminalLine(profile.displayLabel);
    const agent = sanitizeTerminalLine(profile.agent);
    const profileId = profile.accountId === null ? null : sanitizeTerminalLine(profile.accountId);
    if (
      covered.has(`${agent} ${label}`) ||
      (profileId !== null && coveredIds.has(`${agent}:${profileId}`))
    ) {
      continue;
    }
    covered.add(`${agent} ${label}`);
    const storable = unstoredNote(agent);
    rows.push({
      agent,
      label,
      accountId: null,
      isActive: false,
      refreshDead: false,
      quota: null,
      note:
        storable === null
          ? `discovered via ${sanitizeTerminalLine(profile.discoveredVia)}`
          : `${storable} (discovered via ${sanitizeTerminalLine(profile.discoveredVia)})`,
    });
  }

  const groups = groupRows(rows);
  // the cursor indexes `rows`, so it must be the reading order of the
  // blocks — not the order the sources happened to produce
  return {
    rows: groups.flatMap((group) => group.rows),
    groups,
    switchableAgents: SWITCHABLE_AGENTS,
  };
}

export function isSwitchable(row: AccountRowViewModel): boolean {
  return row.accountId !== null && SWITCHABLE_AGENTS.includes(row.agent);
}

/**
 * The login itself is dead, not just unread: switching to it would
 * install credentials that cannot work. `auth_invalid` counts because a
 * revoked codex token reports exactly that before the renewal that
 * quarantines it has run.
 */
function needsRelogin(row: AccountRowViewModel): boolean {
  return row.refreshDead || row.quota?.failure?.kind === 'auth_invalid';
}

/** Switchable agents first, in their canonical order; then the rest. */
function compareAgents(a: string, b: string): number {
  const rank = (agent: string): number => {
    const index = SWITCHABLE_AGENTS.indexOf(agent);
    return index === -1 ? SWITCHABLE_AGENTS.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * Groups by agent, active account first within each block. Sorting is
 * stable, so accounts that are neither active keep the order the
 * sources produced them in — a repaint must not reshuffle the list
 * under a cursor that is pointing at one of them.
 */
function groupRows(rows: readonly AccountRowViewModel[]): AccountGroupViewModel[] {
  const byAgent = new Map<string, AccountRowViewModel[]>();
  for (const row of rows) {
    const existing = byAgent.get(row.agent);
    if (existing === undefined) {
      byAgent.set(row.agent, [row]);
    } else {
      existing.push(row);
    }
  }
  return [...byAgent.keys()].sort(compareAgents).map((agent) => {
    const ordered = [...(byAgent.get(agent) ?? [])].sort(
      (a, b) => Number(b.isActive) - Number(a.isActive),
    );
    return {
      agent,
      switchable: SWITCHABLE_AGENTS.includes(agent),
      needsReloginCount: ordered.filter(needsRelogin).length,
      rows: ordered,
    };
  });
}
