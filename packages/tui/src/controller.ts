import { resolveBinding } from './keybindings.ts';
import type { TuiAction } from './keybindings.ts';
import { HELP_OVERLAY, editInput, movePicker, selectedOption } from './overlay.ts';
import type { ConfirmTopic, PickerTopic, TuiOverlay } from './overlay.ts';
import {
  createInitialState,
  nextTab,
  tabForDigit,
  withActiveTab,
  withClosing,
  withOverlay,
  withSortToggle,
} from './state.ts';
import type { TuiState } from './state.ts';
import { DEFAULT_TAB_VIEWS, renderShell, tabAtColumn } from './views/shell.ts';
import type { TabView } from './views/shell.ts';
import type { TuiKeyEvent, TuiMouseEvent, TuiScreen, TuiTab } from './types.ts';

export interface TuiControllerOptions {
  readonly screen: TuiScreen;
  readonly views?: Record<TuiTab, TabView>;
  readonly nowUtc?: () => number;
  readonly onTabChange?: (tab: TuiTab) => void;
  readonly onRefreshRequest?: () => void;
  readonly onAutoRefreshCycle?: () => void;
  readonly onThemeCycle?: () => void;
  /** Opens a picker; the host builds the option list from live data. */
  readonly onOpenPicker?: (topic: PickerTopic) => void;
  readonly onPickerSelect?: (topic: PickerTopic, optionId: string) => void;
  readonly onConfirm?: (topic: ConfirmTopic, payload: string) => void;
  readonly onAccountsKey?: (key: TuiKeyEvent) => boolean;
  readonly onDoctorKey?: (key: TuiKeyEvent) => boolean;
  readonly onSearchKey?: (key: TuiKeyEvent) => boolean;
  readonly onModelsKey?: (key: TuiKeyEvent) => boolean;
  readonly onInputSubmit?: (value: string) => void;
  /** Body click at a 0-based body row; return true when consumed. */
  readonly onBodyClick?: (bodyRow: number, bodyHeight: number) => boolean;
}

/**
 * Owns state, key handling, and teardown ordering. The screen is
 * destroyed exactly once, no matter which exit path fires first.
 */
/** Tab bar + separator sit above the body in renderShell. */
const BODY_TOP = 2;

export class TuiController {
  private state: TuiState = createInitialState();
  private readonly screen: TuiScreen;
  private readonly views: Record<TuiTab, TabView>;
  private readonly nowUtc: () => number;
  private readonly onTabChange: ((tab: TuiTab) => void) | null;
  private readonly onRefreshRequest: (() => void) | null;
  private readonly onAutoRefreshCycle: (() => void) | null;
  private readonly onThemeCycle: (() => void) | null;
  private readonly onOpenPicker: ((topic: PickerTopic) => void) | null;
  private readonly onPickerSelect: ((topic: PickerTopic, optionId: string) => void) | null;
  private readonly onConfirm: ((topic: ConfirmTopic, payload: string) => void) | null;
  private readonly onAccountsKey: ((key: TuiKeyEvent) => boolean) | null;
  private readonly onDoctorKey: ((key: TuiKeyEvent) => boolean) | null;
  private readonly onSearchKey: ((key: TuiKeyEvent) => boolean) | null;
  private readonly onModelsKey: ((key: TuiKeyEvent) => boolean) | null;
  private readonly onInputSubmit: ((value: string) => void) | null;
  private readonly onBodyClick: ((bodyRow: number, bodyHeight: number) => boolean) | null;
  private stopped = false;
  private started = false;
  private resolveDone: (() => void) | null = null;
  /** Resolves when the user quits (or stop() is called externally). */
  readonly done: Promise<void>;

  constructor(options: TuiControllerOptions) {
    this.screen = options.screen;
    this.views = options.views ?? DEFAULT_TAB_VIEWS;
    this.nowUtc = options.nowUtc ?? ((): number => Math.floor(Date.now() / 1000));
    this.onTabChange = options.onTabChange ?? null;
    this.onRefreshRequest = options.onRefreshRequest ?? null;
    this.onAutoRefreshCycle = options.onAutoRefreshCycle ?? null;
    this.onThemeCycle = options.onThemeCycle ?? null;
    this.onOpenPicker = options.onOpenPicker ?? null;
    this.onPickerSelect = options.onPickerSelect ?? null;
    this.onConfirm = options.onConfirm ?? null;
    this.onAccountsKey = options.onAccountsKey ?? null;
    this.onDoctorKey = options.onDoctorKey ?? null;
    this.onSearchKey = options.onSearchKey ?? null;
    this.onModelsKey = options.onModelsKey ?? null;
    this.onInputSubmit = options.onInputSubmit ?? null;
    this.onBodyClick = options.onBodyClick ?? null;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.screen.onKey((key) => {
      this.handleKey(key);
    });
    this.screen.onMouse?.((event) => {
      this.handleMouse(event);
    });
    this.screen.onResize(() => {
      this.render();
    });
    this.render();
  }

  /**
   * Mouse mapping mirrors the shell layout: row 0 is the tab bar, row 1
   * a separator, and the body starts at row 2. A scroll is delivered as
   * the arrow key the focused tab already understands, so keyboard and
   * wheel can never drift apart.
   */
  handleMouse(event: TuiMouseEvent): void {
    if (this.stopped) {
      return;
    }
    if (event.type === 'scroll') {
      // wheel over a confirm/notice must not move a hidden picker or
      // the list behind the modal (audit GK-40); pickers do scroll
      const overlayKind = this.state.overlay?.kind;
      if (overlayKind !== undefined && overlayKind !== 'picker') {
        return;
      }
      const name = event.scroll === 'up' ? 'up' : 'down';
      this.handleKey({ name, ctrl: false, shift: false });
      return;
    }
    if (this.state.overlay !== null) {
      // a modal owns input; a stray click must not act on what is behind it
      return;
    }
    if (event.y === 0) {
      const tab = tabAtColumn(this.state.activeTab, event.x);
      if (tab !== null) {
        this.switchTab(tab);
      }
      return;
    }
    const bodyRow = event.y - BODY_TOP;
    if (bodyRow >= 0) {
      this.onBodyClick?.(bodyRow, Math.max(1, this.screen.height - 4));
    }
  }

  getState(): TuiState {
    return this.state;
  }

  /** Replaces state and re-renders; used by data/refresh layers. */
  commit(next: TuiState): void {
    if (this.stopped) {
      return;
    }
    this.state = next;
    this.render();
  }

  handleKey(key: TuiKeyEvent): void {
    if (this.state.overlay !== null) {
      // a modal owns input completely: keys it does not act on are
      // swallowed here rather than reaching a tab behind it
      if (!this.handleOverlayKey(key)) {
        const binding = resolveBinding(key, this.state);
        if (binding !== null) {
          this.dispatch(binding.action, key);
        }
      }
      return;
    }
    if (this.state.activeTab === 'accounts' && this.onAccountsKey?.(key) === true) {
      return;
    }
    if (this.state.activeTab === 'doctor' && this.onDoctorKey?.(key) === true) {
      return;
    }
    if (this.state.activeTab === 'search' && this.onSearchKey?.(key) === true) {
      return;
    }
    if (this.state.activeTab === 'models' && this.onModelsKey?.(key) === true) {
      return;
    }
    const binding = resolveBinding(key, this.state);
    if (binding === null) {
      return;
    }
    this.dispatch(binding.action, key);
  }

  /**
   * Overlay keys are handled before the registry so a modal fully owns
   * input. Returns false for keys the overlay does not claim (quit),
   * which then fall through to the normal bindings.
   */
  private handleOverlayKey(key: TuiKeyEvent): boolean {
    const overlay = this.state.overlay;
    if (overlay === null) {
      return false;
    }
    if (overlay.kind === 'notice') {
      if (overlay.busy) {
        // a running action must not be dismissed out from under itself
        return key.name !== 'q' && !(key.name === 'c' && key.ctrl);
      }
      if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
        this.setOverlay(null);
        return true;
      }
      return false;
    }
    if (overlay.kind === 'input') {
      if (key.name === 'return' || key.name === 'enter') {
        this.setOverlay(null);
        this.onInputSubmit?.(overlay.value);
        return true;
      }
      if (key.name === 'escape') {
        this.setOverlay(null);
        return true;
      }
      if (key.ctrl) {
        return true;
      }
      const edited = editInput(overlay, key);
      if (edited !== null) {
        this.setOverlay(edited);
      }
      return true;
    }
    if (overlay.kind === 'confirm') {
      if (key.name === 'y') {
        this.setOverlay(null);
        this.onConfirm?.(overlay.topic, overlay.payload);
        return true;
      }
      if (key.name === 'n' || key.name === 'escape') {
        this.setOverlay(null);
        return true;
      }
      return false;
    }
    if (overlay.kind === 'picker') {
      if (key.name === 'down' || key.name === 'j') {
        this.setOverlay(movePicker(overlay, 1));
        return true;
      }
      if (key.name === 'up' || key.name === 'k') {
        this.setOverlay(movePicker(overlay, -1));
        return true;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const option = selectedOption(overlay);
        this.setOverlay(null);
        if (option !== null) {
          this.onPickerSelect?.(overlay.topic, option.id);
        }
        return true;
      }
      if (key.name === 'escape') {
        this.setOverlay(null);
        return true;
      }
      return false;
    }
    return false;
  }

  setOverlay(overlay: TuiOverlay): void {
    this.state = withOverlay(this.state, overlay);
    this.render();
  }

  private dispatch(action: TuiAction, key: TuiKeyEvent): void {
    switch (action) {
      case 'quit':
        this.stop();
        return;
      case 'refresh':
        this.onRefreshRequest?.();
        return;
      case 'auto-refresh-cycle':
        if (this.onOpenPicker !== null) {
          this.onOpenPicker('auto-refresh');
        } else {
          this.onAutoRefreshCycle?.();
        }
        return;
      case 'theme-cycle':
        if (this.onOpenPicker !== null) {
          this.onOpenPicker('theme');
        } else {
          this.onThemeCycle?.();
          this.render();
        }
        return;
      case 'toggle-help': {
        // Esc only closes; ? toggles. But ? must never REPLACE a
        // standing confirm/input/picker — swapping a destructive
        // confirmation for the help card silently dropped the action
        // (audit GK-23)
        const overlayKind = this.state.overlay?.kind;
        if (overlayKind !== undefined && overlayKind !== 'help' && key.name !== 'escape') {
          return;
        }
        const open = overlayKind === 'help';
        this.setOverlay(key.name === 'escape' || open ? null : HELP_OVERLAY);
        return;
      }
      case 'next-tab':
        this.switchTab(nextTab(this.state, 1).activeTab);
        return;
      case 'previous-tab':
        this.switchTab(nextTab(this.state, -1).activeTab);
        return;
      case 'tab-digit': {
        const digitTab = tabForDigit(key.name);
        if (digitTab !== null) {
          this.switchTab(digitTab);
        }
        return;
      }
      case 'sort-rows':
      case 'sort-cost':
      case 'sort-tokens': {
        if (this.state.activeTab !== 'agents' && this.state.activeTab !== 'models') {
          return;
        }
        const column =
          action === 'sort-rows' ? 'rows' : action === 'sort-cost' ? 'actual' : 'input';
        this.state = withSortToggle(this.state, this.state.activeTab, column);
        this.render();
        return;
      }
      default:
        return;
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.state = withClosing(this.state);
    this.screen.destroy();
    this.resolveDone?.();
  }

  private switchTab(tab: TuiTab): void {
    if (tab === this.state.activeTab) {
      return;
    }
    this.state = withActiveTab(this.state, tab);
    this.render();
    this.onTabChange?.(tab);
  }

  /** Re-renders the current state — the footer's clock and spinner
   * change with wall time, which no state commit represents. */
  redraw(): void {
    if (this.stopped) {
      return;
    }
    this.render();
  }

  private render(): void {
    if (this.stopped) {
      return;
    }
    this.screen.setFrame(
      renderShell(this.state, this.screen.width, this.screen.height, this.nowUtc(), this.views),
    );
  }
}
