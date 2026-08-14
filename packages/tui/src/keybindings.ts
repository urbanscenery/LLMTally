import type { TuiState } from './state.ts';
import type { TuiKeyEvent, TuiTab } from './types.ts';

/**
 * lazygit-style single registry: input dispatch, footer hints, and the
 * help overlay all read the same table, so they can never disagree.
 */
export type TuiAction =
  | 'quit'
  | 'refresh'
  | 'next-tab'
  | 'previous-tab'
  | 'tab-digit'
  | 'sort-rows'
  | 'sort-cost'
  | 'sort-tokens'
  | 'auto-refresh-cycle'
  | 'theme-cycle'
  | 'chart-style'
  | 'toggle-help'
  /** Documented in help; handled by the Accounts tab before dispatch. */
  | 'noop';

interface KeyMatch {
  readonly name: string;
  readonly ctrl?: boolean;
  /**
   * Omitted = wildcard. Kitty-protocol terminals report shifted
   * printables (like `?`) with shift=true, so printable bindings must
   * not pin shift; only Tab needs it to split next/previous.
   */
  readonly shift?: boolean;
}

export interface KeyBinding {
  readonly matches: readonly KeyMatch[];
  readonly action: TuiAction;
  readonly scope: 'global' | readonly TuiTab[];
  readonly group: 'Navigation' | 'Data' | 'Application';
  /** Help overlay text. */
  readonly label: string;
  readonly keysLabel: string;
  /** Footer hint; omitted bindings stay help-only. */
  readonly footer?: { readonly keys: string; readonly text: string };
  /** Footer trim order — higher survives narrow terminals longer. */
  readonly priority: number;
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    matches: [{ name: '1' }, { name: '2' }, { name: '3' }, { name: '4' }, { name: '5' }, { name: '6' }],
    action: 'tab-digit', // resolved per digit in the controller
    scope: 'global',
    group: 'Navigation',
    label: 'jump to tab 1..6',
    keysLabel: '1..6',
    footer: { keys: '[1..6]', text: ' tab' },
    priority: 90,
  },
  {
    matches: [{ name: 'tab', shift: false }, { name: 'right' }],
    action: 'next-tab',
    scope: 'global',
    group: 'Navigation',
    label: 'next tab',
    keysLabel: 'Tab / →',
    priority: 40,
  },
  {
    matches: [{ name: 'tab', shift: true }, { name: 'left' }],
    action: 'previous-tab',
    scope: 'global',
    group: 'Navigation',
    label: 'previous tab',
    keysLabel: 'Shift-Tab / ←',
    priority: 39,
  },
  {
    matches: [{ name: 'd' }],
    action: 'sort-rows',
    scope: ['agents', 'models'],
    group: 'Data',
    label: 'sort by rows (again: flip direction)',
    keysLabel: 'd',
    footer: { keys: '[d/c/t]', text: ' sort' },
    priority: 70,
  },
  {
    matches: [{ name: 'c' }],
    action: 'sort-cost',
    scope: ['agents', 'models'],
    group: 'Data',
    label: 'sort by cost',
    keysLabel: 'c',
    priority: 69,
  },
  {
    matches: [{ name: 't' }],
    action: 'sort-tokens',
    scope: ['agents', 'models'],
    group: 'Data',
    label: 'sort by input tokens',
    keysLabel: 't',
    priority: 68,
  },
  {
    matches: [{ name: 'g' }],
    action: 'chart-style',
    scope: ['overview'],
    group: 'Data',
    label: 'chart style (bars / braille / heatmap)',
    keysLabel: 'g',
    footer: { keys: '[g]', text: 'raph' },
    priority: 66,
  },
  {
    matches: [{ name: 'down' }],
    action: 'noop', // handled by the Overview tab before dispatch
    scope: ['overview'],
    group: 'Data',
    label: 'select a chart day (←/→ move, ↑/Esc close, click works too)',
    keysLabel: '↓ then ←/→',
    priority: 25,
  },
  {
    matches: [{ name: 'r' }],
    action: 'refresh',
    scope: 'global',
    group: 'Data',
    label: 'refresh now (scan + reload)',
    keysLabel: 'r',
    footer: { keys: '[r]', text: 'efresh' },
    priority: 80,
  },
  {
    matches: [{ name: 'a' }],
    action: 'auto-refresh-cycle',
    scope: 'global',
    group: 'Data',
    label: 'auto-refresh interval (off / 30s / 1m / 5m / 10m)',
    keysLabel: 'a',
    footer: { keys: '[a]', text: 'uto' },
    priority: 75,
  },
  {
    matches: [{ name: 'p' }],
    action: 'theme-cycle',
    scope: 'global',
    group: 'Application',
    label: 'choose color theme and surface (remembered)',
    keysLabel: 'p',
    footer: { keys: '[p]', text: ' theme' },
    priority: 50,
  },
  {
    matches: [{ name: '?' }],
    action: 'toggle-help',
    scope: 'global',
    group: 'Application',
    label: 'toggle this help',
    keysLabel: '?',
    footer: { keys: '[?]', text: ' help' },
    priority: 60,
  },
  {
    matches: [{ name: 'n' }],
    action: 'noop',
    scope: ['accounts'],
    group: 'Data',
    label: 'store the account that is logged in now',
    keysLabel: 'n',
    priority: 30,
  },
  {
    matches: [{ name: 's' }],
    action: 'noop',
    scope: ['accounts'],
    group: 'Data',
    label: 'switch to the selected account',
    keysLabel: 's / Enter',
    priority: 28,
  },
  {
    matches: [{ name: 'd' }],
    action: 'noop',
    scope: ['accounts'],
    group: 'Data',
    label: 'detach the codex login (store it, then sign out without revoking)',
    keysLabel: 'd',
    priority: 27,
  },
  {
    matches: [{ name: 'x' }],
    action: 'noop',
    scope: ['accounts'],
    group: 'Data',
    label: 'forget the selected account',
    keysLabel: 'x',
    priority: 26,
  },
  {
    matches: [{ name: 'D' }, { name: 'd', shift: true }],
    action: 'noop',
    scope: ['doctor'],
    group: 'Data',
    label: 'install the hourly background collection agent',
    keysLabel: 'D',
    priority: 24,
  },
  {
    matches: [{ name: 'U' }, { name: 'u', shift: true }],
    action: 'noop',
    scope: ['doctor'],
    group: 'Data',
    label: 'remove the background collection agent',
    keysLabel: 'U',
    priority: 23,
  },
  {
    matches: [{ name: 'V' }, { name: 'v', shift: true }],
    action: 'noop',
    scope: ['doctor'],
    group: 'Data',
    label: 'compact the ledger (reclaim freed space)',
    keysLabel: 'V',
    priority: 22,
  },
  {
    matches: [{ name: 'escape' }],
    action: 'toggle-help',
    scope: 'global',
    group: 'Application',
    label: 'close overlay',
    keysLabel: 'Esc',
    priority: 1,
  },
  {
    matches: [{ name: 'q' }, { name: 'c', ctrl: true }],
    action: 'quit',
    scope: 'global',
    group: 'Application',
    label: 'quit',
    keysLabel: 'q / Ctrl-C',
    footer: { keys: '[q]', text: 'uit' },
    priority: 100,
  },
];

function matchesEvent(match: KeyMatch, key: TuiKeyEvent): boolean {
  return (
    match.name === key.name &&
    (match.ctrl ?? false) === key.ctrl &&
    (match.shift === undefined || match.shift === key.shift)
  );
}

function inScope(binding: KeyBinding, tab: TuiTab): boolean {
  return binding.scope === 'global' || binding.scope.includes(tab);
}

/**
 * While the help overlay is open only quit and toggle-help fire —
 * everything else is blocked so the overlay cannot mutate hidden state.
 */
export function resolveBinding(key: TuiKeyEvent, state: TuiState): KeyBinding | null {
  for (const binding of KEY_BINDINGS) {
    if (!binding.matches.some((match) => matchesEvent(match, key))) {
      continue;
    }
    if (state.overlay !== null && binding.action !== 'quit' && binding.action !== 'toggle-help') {
      return null;
    }
    if (!inScope(binding, state.activeTab)) {
      continue;
    }
    return binding;
  }
  return null;
}

/** Footer hints for the active tab, highest priority first. */
export function footerBindings(state: TuiState): readonly KeyBinding[] {
  return KEY_BINDINGS.filter(
    (binding) => binding.footer !== undefined && inScope(binding, state.activeTab),
  ).toSorted((a, b) => b.priority - a.priority);
}

export function helpGroups(): ReadonlyMap<string, readonly KeyBinding[]> {
  const groups = new Map<string, KeyBinding[]>();
  for (const binding of KEY_BINDINGS) {
    const list = groups.get(binding.group) ?? [];
    list.push(binding);
    groups.set(binding.group, list);
  }
  return groups;
}
