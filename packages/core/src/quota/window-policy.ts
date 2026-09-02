/**
 * Cross-surface quota-window naming and ordering policy. The TUI and
 * the menu-bar app (via the sidecar) both sort with this, so gauges
 * line up identically on every surface.
 */

/**
 * Providers name the same windows differently (`five_hour`,
 * `primary (300m)`, `seven_day_opus`, `7d Fable`, …). Displayed labels
 * follow one policy — `5hours` / `7days` / `1month`, model-scoped as
 * `7days_<Model>` — so the eye compares like with like across agents.
 * Ids that fit no known shape keep their original label.
 */
export interface NormalizedWindow {
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
  // adapters keep each vendor's own window name so history stays
  // traceable to its source; the policy mapping lives only here
  if (id === 'five_hour' || id === 'rolling') {
    return { label: '5hours', rank: 0, model: null };
  }
  if (id === 'seven_day' || id === 'weekly') {
    return { label: '7days', rank: 1, model: null };
  }
  if (id === 'monthly') {
    return { label: '1month', rank: 2, model: null };
  }
  if (id === 'cursor_models') {
    return { label: '1month_CursorModels', rank: 2, model: 'CursorModels' };
  }
  if (id === 'other_models') {
    return { label: '1month_OtherModels', rank: 2, model: 'OtherModels' };
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
export function compareWindows(a: NormalizedWindow, b: NormalizedWindow): number {
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

/** Returns the windows in canonical gauge order (input untouched). */
export function sortQuotaWindows<T extends { readonly id: string }>(
  windows: readonly T[],
): T[] {
  return windows
    .map((window) => ({ window, normalized: normalizeQuotaWindow(window.id) }))
    .sort((a, b) => compareWindows(a.normalized, b.normalized))
    .map(({ window }) => window);
}
