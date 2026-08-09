import { TUI_TABS } from './types.ts';
import type { RefreshState, ResourceState, TuiTab } from './types.ts';
import type { BreakdownTabViewModel } from './view-model/breakdown.ts';
import type { OverviewViewModel } from './view-model/overview.ts';
import type { AccountsTabViewModel } from './view-model/accounts.ts';
import type { DoctorTabViewModel } from './view-model/doctor.ts';
import type { PromptsViewModel } from './view-model/prompts.ts';
import type { TuiOverlay } from './overlay.ts';

export type BreakdownSortColumn = 'rows' | 'actual' | 'input';

export interface SortSpec {
  readonly column: BreakdownSortColumn;
  readonly direction: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortSpec = { column: 'rows', direction: 'desc' };


export interface TuiState {
  readonly activeTab: TuiTab;
  readonly closing: boolean;
  readonly overlay: TuiOverlay;
  readonly overview: ResourceState<OverviewViewModel>;
  readonly accounts: ResourceState<AccountsTabViewModel>;
  readonly agents: ResourceState<BreakdownTabViewModel>;
  readonly models: ResourceState<BreakdownTabViewModel>;
  readonly search: ResourceState<PromptsViewModel>;
  readonly doctor: ResourceState<DoctorTabViewModel>;
  readonly agentsSort: SortSpec;
  readonly modelsSort: SortSpec;
  readonly refresh: RefreshState;
  readonly accountsCursor: number;
  readonly searchCursor: number;
  readonly searchQuery: string;
  /** Model the Models tab drilled into; null shows the aggregate table. */
  readonly modelDrillDown: string | null;
  readonly modelPrompts: ResourceState<PromptsViewModel>;
  readonly modelPromptsCursor: number;
  readonly modelsCursor: number;
}

export function withTabResource<T extends TuiTab>(
  state: TuiState,
  tab: T,
  resource: TuiState[T],
): TuiState {
  return { ...state, [tab]: resource };
}

/** Marks resources stale while keeping their data on screen. */
export function withInvalidatedTabs(state: TuiState, tabs: readonly TuiTab[]): TuiState {
  let next = state;
  for (const tab of tabs) {
    const resource = next[tab];
    if (!resource.invalidated) {
      next = withTabResource(next, tab, { ...resource, invalidated: true });
    }
  }
  return next;
}

export function withRefresh(state: TuiState, refresh: Partial<RefreshState>): TuiState {
  return { ...state, refresh: { ...state.refresh, ...refresh } };
}

/** Same column toggles direction; a new column starts descending. */
export function withSortToggle(
  state: TuiState,
  tab: 'agents' | 'models',
  column: BreakdownSortColumn,
): TuiState {
  const key = tab === 'agents' ? 'agentsSort' : 'modelsSort';
  const current = state[key];
  const next: SortSpec =
    current.column === column
      ? { column, direction: current.direction === 'desc' ? 'asc' : 'desc' }
      : { column, direction: 'desc' };
  return { ...state, [key]: next };
}

export function sortSpecFor(state: TuiState, tab: 'agents' | 'models'): SortSpec {
  return tab === 'agents' ? state.agentsSort : state.modelsSort;
}

export function withOverlay(state: TuiState, overlay: TuiOverlay): TuiState {
  return state.overlay === overlay ? state : { ...state, overlay };
}

/** Cursor for the Accounts tab; clamped by the view against its rows. */
export function withAccountsCursor(state: TuiState, cursor: number): TuiState {
  return state.accountsCursor === cursor ? state : { ...state, accountsCursor: Math.max(0, cursor) };
}

export function withSearchCursor(state: TuiState, cursor: number): TuiState {
  return { ...state, searchCursor: Math.max(0, cursor) };
}

export function withSearchQuery(state: TuiState, query: string): TuiState {
  return { ...state, searchQuery: query, searchCursor: 0 };
}

/** Entering a model resets its prompt cursor; leaving clears the list. */
export function withModelDrillDown(state: TuiState, model: string | null): TuiState {
  return {
    ...state,
    modelDrillDown: model,
    modelPromptsCursor: 0,
    modelsCursor: 0,
    modelPrompts:
      model === null
        ? { phase: 'idle', data: null, error: null, updatedAtUtc: null, invalidated: false }
        : { ...state.modelPrompts, invalidated: true },
  };
}

export function withModelPromptsCursor(state: TuiState, cursor: number): TuiState {
  return { ...state, modelPromptsCursor: Math.max(0, cursor) };
}

export function withModelsCursor(state: TuiState, cursor: number): TuiState {
  return { ...state, modelsCursor: Math.max(0, cursor) };
}

export function emptyResource<T>(): ResourceState<T> {
  return { phase: 'idle', data: null, error: null, updatedAtUtc: null, invalidated: false };
}

export function createInitialState(): TuiState {
  return {
    activeTab: 'overview',
    closing: false,
    overlay: null,
    accountsCursor: 0,
    searchCursor: 0,
    searchQuery: '',
    modelDrillDown: null,
    modelPrompts: emptyResource(),
    modelPromptsCursor: 0,
    modelsCursor: 0,
    overview: emptyResource(),
    accounts: emptyResource(),
    agents: emptyResource(),
    models: emptyResource(),
    search: emptyResource(),
    doctor: emptyResource(),
    agentsSort: DEFAULT_SORT,
    modelsSort: DEFAULT_SORT,
    refresh: {
      inFlight: false,
      pending: false,
      reason: null,
      scanStatus: 'idle',
      lastCompletedAtUtc: null,
      autoIntervalSeconds: null,
    },
  };
}

export function withActiveTab(state: TuiState, tab: TuiTab): TuiState {
  return state.activeTab === tab ? state : { ...state, activeTab: tab };
}

export function nextTab(state: TuiState, step: 1 | -1): TuiState {
  const index = TUI_TABS.indexOf(state.activeTab);
  const target = TUI_TABS[(index + step + TUI_TABS.length) % TUI_TABS.length] ?? 'overview';
  return withActiveTab(state, target);
}

export function tabForDigit(digit: string): TuiTab | null {
  const index = Number.parseInt(digit, 10) - 1;
  return Number.isInteger(index) ? (TUI_TABS[index] ?? null) : null;
}

export function withClosing(state: TuiState): TuiState {
  return state.closing ? state : { ...state, closing: true };
}
