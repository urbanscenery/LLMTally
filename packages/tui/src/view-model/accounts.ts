import type { AccountProfile } from '@llmtally/core/accounts/discovery.ts';
import type { VaultEntry } from '@llmtally/core/accounts/vault.ts';
import type { QuotaFailure, QuotaSnapshot, QuotaSource } from '@llmtally/core/quota/providers.ts';
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

export interface AccountsTabViewModel {
  readonly rows: readonly AccountRowViewModel[];
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

export const SWITCHABLE_AGENTS: readonly string[] = ['claude-code', 'codex', 'opencode'];

/** Which account id counts as "active" for rows of this agent. */
function activeIdFor(agent: string, input: AccountsInput): string | null {
  if (agent === 'claude-code') {
    return input.activeAccountId;
  }
  return input.activeByAgent?.[agent] ?? null;
}

/**
 * Providers name the same windows differently (`five_hour`,
 * `primary (300m)`, `seven_day_opus`, `7d Fable`, …). Displayed labels
 * follow one policy — `5hours` / `7days` / `1month`, model-scoped as
 * `7days_<Model>` — so the eye compares like with like across agents.
 * Ids that fit no known shape keep their original label.
 */
interface NormalizedWindow {
  readonly label: string;
  /** 5h → 0, 7d → 1, 1month → 2, unknown → 3. */
  readonly rank: number;
  readonly model: string | null;
}

const POLICY_LABELS = ['5hours', '7days', '1month'] as const;

function policyRankForMinutes(minutes: number): number | null {
  if (minutes >= 240 && minutes <= 360) {
    return 0;
  }
  if (minutes >= 9360 && minutes <= 10800) {
    return 1;
  }
  if (minutes >= 40320 && minutes <= 44640) {
    return 2;
  }
  return null;
}

/** Codex windows named after the shared budget, not a model. */
const CODEX_COMMON_BASES: ReadonlySet<string> = new Set([
  'primary',
  'secondary',
  'primary secondary',
]);

export function normalizeQuotaWindow(id: string): NormalizedWindow {
  if (id === 'five_hour') {
    return { label: '5hours', rank: 0, model: null };
  }
  if (id === 'seven_day') {
    return { label: '7days', rank: 1, model: null };
  }
  if (id === 'seven_day_opus') {
    return { label: '7days_Opus', rank: 1, model: 'Opus' };
  }
  const claudeScoped = /^7d (.+)$/.exec(id);
  if (claudeScoped?.[1] !== undefined) {
    return { label: `7days_${claudeScoped[1]}`, rank: 1, model: claudeScoped[1] };
  }
  // the paid overage axis resets monthly; the spend figures ARE the label
  if (id.startsWith('extra usage')) {
    return { label: id, rank: 2, model: null };
  }
  const minuteSuffixed = /^(.+) \((\d+)m\)$/.exec(id);
  if (minuteSuffixed?.[1] !== undefined && minuteSuffixed[2] !== undefined) {
    const rank = policyRankForMinutes(Number(minuteSuffixed[2]));
    if (rank !== null) {
      const base = minuteSuffixed[1];
      const model = CODEX_COMMON_BASES.has(base) ? null : base;
      const label = model === null ? POLICY_LABELS[rank] : `${POLICY_LABELS[rank]}_${model}`;
      return { label: label ?? id, rank, model };
    }
  }
  return { label: id, rank: 3, model: null };
}

/**
 * Canonical gauge order: shortest window first (5hours, 7days, 1month,
 * then unknown), the shared window before model-scoped ones, models
 * alphabetically. Sources deliver windows in different orders (live =
 * provider order, stored history = alphabetical); sorting here is what
 * keeps a card from reshuffling when the source changes between reads.
 */
function compareWindows(a: NormalizedWindow, b: NormalizedWindow): number {
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  if ((a.model === null) !== (b.model === null)) {
    return a.model === null ? -1 : 1;
  }
  const byModel = (a.model ?? '').localeCompare(b.model ?? '');
  if (byModel !== 0) {
    return byModel;
  }
  return a.label.localeCompare(b.label);
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
      claimedVault.add(entry.accountId);
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
        entry === undefined && matches.length > 1
          ? `${matches.length} stored accounts share this address — select the one you want and press s`
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
      isActive: entry.accountId === activeIdFor(entry.agent, input),
      refreshDead: entry.refreshDeadAtUtc !== null,
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
      refreshDead: false,
      quota: null,
      note: `discovered via ${sanitizeTerminalLine(profile.discoveredVia)}`,
    });
  }

  return { rows, switchableAgents: SWITCHABLE_AGENTS };
}

export function isSwitchable(row: AccountRowViewModel): boolean {
  return row.accountId !== null && SWITCHABLE_AGENTS.includes(row.agent);
}
