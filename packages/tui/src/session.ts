/**
 * Wires the TUI together: tabs, refresh, pickers, and the account
 * actions. The CLI only parses flags and hands this a screen and a data
 * source, so every interaction lives in one place instead of being
 * split between the command and the controller.
 */
import { claudeSwitchPreflight } from '@llmtally/core/accounts/switch.ts';
import { loadUiPreferences, saveUiPreferences } from '@llmtally/core/config/preferences.ts';
import type { UiPreferences } from '@llmtally/core/config/preferences.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';

import { TuiController } from './controller.ts';
import type { TuiDataSource } from './data-source.ts';
import { TabLoader } from './loader.ts';
import { AUTO_INTERVALS, RefreshScheduler, autoIntervalLabel } from './refresh.ts';
import { makePicker } from './overlay.ts';
import type { ConfirmTopic, PickerOption, PickerTopic } from './overlay.ts';
import {
  withAccountsCursor,
  withInvalidatedTabs,
  withModelDrillDown,
  withModelPromptsCursor,
  withOverviewSelectedDate,
  withPromptDetail,
  withPromptDetailScroll,
  withSearchCursor,
  withModelsCursor,
  withSearchQuery,
  withTabResource,
  sortSpecFor,
} from './state.ts';
import type { PromptDetailState } from './state.ts';
import { toPromptDetailViewModel } from './view-model/prompt-detail.ts';
import type { PromptDetailViewModel } from './view-model/prompt-detail.ts';
import { PROMPT_DETAIL_HEADER_LINES, clampDetailScroll, promptDetailLines } from './views/prompt-detail.ts';
import { shellBodyHeight } from './views/shell.ts';
import { MONO_THEME, THEMES, canonicalThemeName, findTheme, resolveTheme, shouldPaintSurface } from './theme.ts';
import type { ResolvedTheme } from './theme.ts';
import { CHART_STYLES, CHART_STYLE_LABELS, isChartStyle } from './components/chart-style.ts';
import type { ChartStyle } from './components/chart-style.ts';
import type { ResourceState, TuiKeyEvent, TuiScreen } from './types.ts';
import type { PromptListResult } from '@llmtally/core/report/prompts.ts';
import type { PromptsViewModel } from './view-model/prompts.ts';
import { toDayDetailViewModel } from './view-model/day-detail.ts';
import type { DayDetailViewModel } from './view-model/day-detail.ts';
import { tableWindow } from './components/breakdown-table.ts';
import { isSwitchable } from './view-model/accounts.ts';
import { clampCursor } from './views/accounts.ts';
import { accountsTabView } from './views/accounts.ts';
import { agentsTabView, modelsTabView } from './views/breakdown.ts';
import { sortBreakdownRows } from './view-model/breakdown.ts';
import { PROMPT_LIST_HEADER_LINES, promptIndexAtLine, promptWindowStart } from './views/prompts.ts';

/** Blank line, summary, header, and rule precede the first data row. */
const MODELS_TABLE_HEADER_LINES = 4;
import { doctorTabView } from './views/doctor.ts';
import { searchTabView } from './views/search.ts';
import { toPromptsViewModel } from './view-model/prompts.ts';
import { makeOverviewTabView, overviewDateAtClick } from './views/overview.ts';

export const MONO_THEME_NAME = 'mono';
/** Matches the core quota cache TTL, so a poll is at most one vendor call. */
// Matches the core throttle's 180s cadence: polling faster only produces
// cache hits, and the vendor budget (~28-30 requests/rolling hour per
// token) cannot absorb more than ~20 real fetches an hour anyway.
const QUOTA_POLL_MS = 180_000;

export interface TuiSessionOptions {
  /** Given a live theme provider, builds the screen to render into. */
  readonly createScreen: (themeProvider: () => ResolvedTheme) => Promise<TuiScreen>;
  readonly dataSource: TuiDataSource;
  /** Flag override; when null the remembered chart style is used. */
  readonly chartMode: ChartStyle | null;
  /** Flag override; when absent the remembered preference is used. */
  readonly themeName: string | null;
  readonly refreshSeconds: number | null | undefined;
  /** NO_COLOR or --theme mono: colors stay off whatever is picked. */
  readonly monoForced: boolean;
  /** No ledger yet: the startup scan imports everything, which is slow. */
  readonly firstRun?: boolean;
  /** Quota poll interval; tests shorten it. */
  readonly quotaPollMs?: number;
  readonly preferences?: {
    load: () => UiPreferences;
    save: (patch: Partial<UiPreferences>) => string | null;
  };
}

const SURFACE_TERMINAL = 'surface:terminal';
const SURFACE_PAINTED = 'surface:painted';

/** Tracks the chosen theme and resolves it once per theme, not per frame. */
class ThemeSelection {
  readonly #resolved = new Map<string, ResolvedTheme>();
  #name: string;
  #userPaint: boolean;

  constructor(name: string, userPaint: boolean, private readonly monoForced: boolean) {
    // stored ids may predate the shared catalog ('default', 'tokyonight')
    this.#name = name === MONO_THEME_NAME ? name : canonicalThemeName(name);
    this.#userPaint = userPaint;
    for (const theme of THEMES) {
      this.#resolved.set(`${theme.name}:term`, resolveTheme(theme));
      this.#resolved.set(`${theme.name}:paint`, resolveTheme(theme, { paintSurface: true }));
    }
  }

  get name(): string {
    return this.#name;
  }

  paints(): boolean {
    return shouldPaintSurface(findTheme(this.#name), this.#userPaint, this.monoForced || this.#name === MONO_THEME_NAME);
  }

  select(name: string): void {
    if (name === MONO_THEME_NAME) {
      this.#name = name;
      return;
    }
    const canonical = canonicalThemeName(name);
    if (findTheme(canonical) !== null) {
      this.#name = canonical;
      if (findTheme(canonical)?.requiresBackground === true) {
        this.#userPaint = true;
      }
    }
  }

  setPaint(paint: boolean): string | null {
    if (!paint && findTheme(this.#name)?.requiresBackground === true) {
      return 'Light themes paint their surface. Switch to a dark theme first.';
    }
    this.#userPaint = paint;
    return null;
  }

  current(): ResolvedTheme {
    if (this.monoForced || this.#name === MONO_THEME_NAME) {
      return MONO_THEME;
    }
    const key = `${this.#name}:${this.paints() ? 'paint' : 'term'}`;
    return this.#resolved.get(key) ?? MONO_THEME;
  }

  options(): PickerOption[] {
    const paints = this.paints();
    const light = findTheme(this.#name)?.requiresBackground === true;
    const options: PickerOption[] = [
      {
        id: SURFACE_TERMINAL,
        label: 'Terminal background',
        hint: light ? 'light themes paint' : paints ? undefined : 'current',
        disabled: light,
      },
      {
        id: SURFACE_PAINTED,
        label: 'Paint theme surface',
        hint: paints ? 'current' : undefined,
      },
    ];
    for (const theme of THEMES) {
      options.push({
        id: theme.name,
        label: theme.label,
        hint:
          theme.name === this.#name
            ? 'current'
            : theme.requiresBackground
              ? 'light · paints'
              : undefined,
      });
    }
    options.push({
      id: MONO_THEME_NAME,
      label: 'mono (no colors)',
      hint: this.monoForced ? 'forced by NO_COLOR' : this.#name === MONO_THEME_NAME ? 'current' : undefined,
    });
    return options;
  }
}

function autoRefreshOptions(current: number | null): PickerOption[] {
  return AUTO_INTERVALS.map((seconds) => ({
    id: seconds === null ? 'off' : String(seconds),
    label: seconds === null ? 'off' : autoIntervalLabel(seconds),
    hint: seconds === current ? 'current' : undefined,
  }));
}

export interface TuiSession {
  run(): Promise<void>;
  stop(): void;
}

export async function createTuiSession(options: TuiSessionOptions): Promise<TuiSession> {
  const prefs = options.preferences ?? {
    load: () => loadUiPreferences(),
    save: (patch: Partial<UiPreferences>) => saveUiPreferences(patch),
  };
  const remembered = prefs.load();
  const theme = new ThemeSelection(
    options.themeName ?? remembered.theme ?? 'catppuccin',
    remembered.paintBackground === true,
    options.monoForced,
  );
  const initialInterval =
    options.refreshSeconds !== undefined ? options.refreshSeconds : (remembered.autoRefreshSeconds ?? null);
  let chartStyle: ChartStyle =
    options.chartMode ?? (isChartStyle(remembered.chartStyle) ? remembered.chartStyle : 'block');

  let loader: TabLoader | null = null;
  let scheduler: RefreshScheduler | null = null;
  let running = false;
  let quotaTimer: ReturnType<typeof setInterval> | null = null;
  let footerTicker: ReturnType<typeof setInterval> | null = null;

  const screen = await options.createScreen(() => theme.current());
  const controller = new TuiController({
    screen,
    views: {
      overview: makeOverviewTabView(() => chartStyle),
      accounts: accountsTabView,
      agents: agentsTabView,
      models: modelsTabView,
      search: searchTabView,
      doctor: doctorTabView,
    },
    onTabChange: (tab) => {
      loader?.loadIfNeeded(tab);
    },
    onRefreshRequest: () => {
      // r means "get me current numbers", so the quota cache must not
      // answer it with the reading it just served
      options.dataSource.invalidateQuotaCache();
      controller.commit(withInvalidatedTabs(controller.getState(), ['accounts']));
      loader?.loadIfNeeded('accounts');
      scheduler?.requestManual();
    },
    onOpenPicker: (topic) => {
      openPicker(topic);
    },
    onPickerSelect: (topic, optionId) => {
      applyPick(topic, optionId);
    },
    onConfirm: (topic, payload) => {
      void runConfirmed(topic, payload);
    },
    onAccountsKey: (key) => handleAccountsKey(key),
    onDoctorKey: (key) => handleDoctorKey(key),
    onSearchKey: (key) => handleSearchKey(key),
    onModelsKey: (key) => handleModelsKey(key),
    onOverviewKey: (key) => handleOverviewKey(key),
    onInputSubmit: (value) => {
      runSearch(value);
    },
    onBodyClick: (bodyRow, bodyHeight, column) => handleBodyClick(bodyRow, bodyHeight, column),
  });

  function notice(title: string, message: string, busy: boolean): void {
    controller.setOverlay({
      kind: 'notice',
      title,
      // Sanitize per line, not over the whole blob: a newline is a
      // control character, so sanitizing the join would weld a result
      // and its warnings into one unreadable run — which is exactly
      // what a multi-warning account switch produces.
      message: message.split('\n').map(sanitizeTerminalLine).join('\n'),
      busy,
    });
  }

  function openPicker(topic: PickerTopic): void {
    if (topic === 'theme') {
      controller.setOverlay(makePicker('theme', 'Theme', theme.options(), theme.name));
      return;
    }
    if (topic === 'auto-refresh') {
      const current = controller.getState().refresh.autoIntervalSeconds;
      controller.setOverlay(
        makePicker('auto-refresh', 'Auto refresh', autoRefreshOptions(current), current === null ? 'off' : String(current)),
      );
      return;
    }
    if (topic === 'chart-style') {
      const styleOptions: PickerOption[] = CHART_STYLES.map((style) => ({
        id: style,
        label: CHART_STYLE_LABELS[style],
        hint: style === chartStyle ? 'current' : undefined,
      }));
      controller.setOverlay(makePicker('chart-style', 'Chart style', styleOptions, chartStyle));
    }
  }

  function applyPick(topic: PickerTopic, optionId: string): void {
    if (topic === 'theme') {
      if (optionId === SURFACE_TERMINAL || optionId === SURFACE_PAINTED) {
        const refused = theme.setPaint(optionId === SURFACE_PAINTED);
        if (refused !== null) {
          notice('Theme', refused, false);
          return;
        }
        const error = prefs.save({ paintBackground: theme.paints() });
        if (error !== null) {
          notice('Theme', error, false);
          return;
        }
        controller.commit(controller.getState());
        return;
      }
      theme.select(optionId);
      const error = prefs.save({ theme: optionId, paintBackground: theme.paints() });
      if (error !== null) {
        notice('Theme', error, false);
        return;
      }
      controller.commit(controller.getState());
      return;
    }
    if (topic === 'auto-refresh') {
      const seconds = optionId === 'off' ? null : Number.parseInt(optionId, 10);
      const value = seconds === null || Number.isNaN(seconds) ? null : seconds;
      scheduler?.setAutoInterval(value);
      const error = prefs.save({ autoRefreshSeconds: value });
      if (error !== null) {
        notice('Auto refresh', error, false);
      }
      return;
    }
    if (topic === 'chart-style') {
      if (!isChartStyle(optionId)) {
        return;
      }
      chartStyle = optionId;
      const error = prefs.save({ chartStyle: optionId });
      if (error !== null) {
        notice('Chart style', error, false);
        return;
      }
      controller.commit(controller.getState());
    }
  }

  function selectedRow() {
    const state = controller.getState();
    const rows = state.accounts.data?.rows ?? [];
    return rows[clampCursor(state.accountsCursor, rows.length)];
  }

  function moveCursor(delta: number): void {
    const state = controller.getState();
    const rows = state.accounts.data?.rows ?? [];
    if (rows.length === 0) {
      return;
    }
    const next = clampCursor(state.accountsCursor + delta, rows.length);
    controller.commit(withAccountsCursor(state, next));
  }

  /** Returns true when the Accounts tab consumed the key. */
  function handleAccountsKey(key: TuiKeyEvent): boolean {
    if (key.name === 'down' || key.name === 'j') {
      moveCursor(1);
      return true;
    }
    if (key.name === 'up' || key.name === 'k') {
      moveCursor(-1);
      return true;
    }
    if (key.name === 'n') {
      // the walkthrough comes BEFORE the capture: llmtally has no login
      // flow of its own — signing in always happens inside Claude Code
      controller.setOverlay({
        kind: 'confirm',
        topic: 'account-add',
        title: 'Add account',
        // paragraphs use single logical lines: the overlay wraps to the
        // card width it actually gets, so a mid-sentence hard newline
        // would double-wrap on narrow terminals and pin the height on
        // short ones
        message:
          'Stores the logins Claude Code, Codex, and OpenCode are using right now.\n' +
          '\n' +
          'To add a different account, sign in with it first:\n' +
          '  · claude-code: run "claude" and use /login\n' +
          '  · codex: press d here FIRST, then run "codex login"\n' +
          '  · opencode: run "opencode auth login"\n' +
          'then come back here and press n.\n' +
          '\n' +
          'Codex is the odd one out: "codex login" revokes whatever login auth.json still holds, which kills the account you just stored. Pressing d first stores it and moves the file out of the way, so there is nothing left to revoke.\n' +
          '\n' +
          'Store the current logins?',
        payload: '',
      });
      return true;
    }
    if (key.name === 'd') {
      // detach is a codex-only, destructive-adjacent action: firing it
      // from a Claude row logged out live codex by surprise (audit
      // GK-38). The cursor names the target; require a codex row.
      if (selectedRow()?.agent !== 'codex') {
        return true;
      }
      controller.setOverlay({
        kind: 'confirm',
        topic: 'account-detach',
        title: 'Detach codex login',
        message:
          'Stores the codex login that is active now, then signs codex out locally. Nothing is revoked — the login stays usable and you can bring it back here with s.\n' +
          '\n' +
          'Do this before "codex login" when adding a second codex account: that command revokes whatever auth.json still holds.\n' +
          '\n' +
          'Detach the current codex login?',
        payload: '',
      });
      return true;
    }
    const row = selectedRow();
    if ((key.name === 's' || key.name === 'return' || key.name === 'enter') && row !== undefined) {
      // gate on switchable agents: opening a switch confirm on a
      // grok/cline/antigravity row would fall through to the Claude
      // switch path and could move the WRONG product's login
      // (audit GK-26)
      // the hint line already refuses these; the key handler must
      // agree or a dead login gets a confirm it can only fail
      // (audit codex C2-15 / grok C2-14)
      if (row.accountId === null || row.isActive || !isSwitchable(row) || row.refreshDead) {
        return true;
      }
      // preflight: a running session may revert the switch on its next
      // token refresh — say so BEFORE the user commits, never after
      const livePids =
        row.agent === 'claude-code' ? claudeSwitchPreflight().liveSessionPids : [];
      const liveWarning =
        livePids.length === 0
          ? ''
          : ` (${livePids.length} running Claude Code session(s) may revert this switch on their next token refresh — quit them first for a clean switch)`;
      controller.setOverlay({
        kind: 'confirm',
        topic: 'account-switch',
        title: 'Switch account',
        message: `Switch ${row.agent} to ${row.label}?${liveWarning}`,
        payload: `${row.agent}:${row.accountId}`,
      });
      return true;
    }
    if (key.name === 'x' && row !== undefined && row.accountId !== null) {
      controller.setOverlay({
        kind: 'confirm',
        topic: 'account-remove',
        title: 'Remove account',
        message: row.isActive
          ? `${row.label} is the account you are logged in as. Forget its stored credentials anyway? You would have to log in again to switch back.`
          : `Forget stored credentials for ${row.label}?`,
        payload: `${row.agent}:${row.accountId}`,
      });
      return true;
    }
    return false;
  }

  /**
   * Production OpenTUI normalizes a shifted letter to lowercase name +
   * shift=true; test fakes historically sent the literal capital. Both
   * must reach the Doctor actions (audit CX-21).
   */
  function isShifted(key: TuiKeyEvent, letter: string): boolean {
    return key.name === letter.toUpperCase() || (key.name === letter && key.shift);
  }

  /** Returns true when the Doctor tab consumed the key. */
  function handleDoctorKey(key: TuiKeyEvent): boolean {
    if (isShifted(key, 'd')) {
      controller.setOverlay({
        kind: 'confirm',
        topic: 'daemon-install',
        title: 'Background collection',
        message: 'Install the background collection agent (hourly scans)?',
        payload: '',
      });
      return true;
    }
    if (isShifted(key, 'u')) {
      controller.setOverlay({
        kind: 'confirm',
        topic: 'daemon-uninstall',
        title: 'Background collection',
        message: 'Remove the background collection agent?',
        payload: '',
      });
      return true;
    }
    if (isShifted(key, 'v')) {
      controller.setOverlay({
        kind: 'confirm',
        topic: 'ledger-compact',
        title: 'Compact ledger',
        message:
          'Rewrites the ledger to return the space freed by retention and deletes. Blocks collection while it runs (seconds for a few hundred MB) and needs about the current file size free.\n' +
          '\n' +
          'Compact the ledger now?',
        payload: '',
      });
      return true;
    }
    return false;
  }

  function listCursor(rowCount: number, cursor: number, delta: number): number {
    if (rowCount === 0) {
      return 0;
    }
    return Math.max(0, Math.min(cursor + delta, rowCount - 1));
  }

  function handleSearchKey(key: TuiKeyEvent): boolean {
    const state = controller.getState();
    if (state.promptDetail?.origin === 'search') {
      return handlePromptDetailKey(key);
    }
    if (key.name === '/') {
      controller.setOverlay({
        kind: 'input',
        title: 'Search prompts',
        prompt: 'Matches the words as one exact phrase in stored prompt text.',
        value: state.searchQuery,
      });
      return true;
    }
    const rows = state.search.data?.rows.length ?? 0;
    if (key.name === 'down' || key.name === 'j') {
      controller.commit(withSearchCursor(state, listCursor(rows, state.searchCursor, 1)));
      return true;
    }
    if (key.name === 'up' || key.name === 'k') {
      controller.commit(withSearchCursor(state, listCursor(rows, state.searchCursor, -1)));
      return true;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const selected = state.search.data?.rows[Math.min(state.searchCursor, rows - 1)];
      if (selected !== undefined) {
        openPromptDetail('search', selected.id);
      }
      return true;
    }
    return false;
  }

  function runSearch(query: string): void {
    const trimmed = query.trim();
    controller.commit(withSearchQuery(controller.getState(), trimmed));
    if (trimmed === '') {
      controller.commit(
        withTabResource(controller.getState(), 'search', {
          phase: 'idle',
          data: null,
          error: null,
          updatedAtUtc: null,
          invalidated: false,
        }),
      );
      return;
    }
    void loadPromptsInto('search', trimmed, () =>
      options.dataSource.loadPrompts({ model: null, search: trimmed }),
    );
  }

  /** Enter opens the selected model; Esc returns to the aggregate table. */
  function handleModelsKey(key: TuiKeyEvent): boolean {
    const state = controller.getState();
    if (state.modelDrillDown === null) {
      // the table is sorted for display, so the cursor must index the
      // sorted order or Enter would open a different model than the
      // highlighted one
      const rows = sortBreakdownRows(state.models.data?.rows ?? [], sortSpecFor(state, 'models'));
      if (key.name === 'down' || key.name === 'j') {
        controller.commit(withModelsCursor(state, listCursor(rows.length, state.modelsCursor, 1)));
        return true;
      }
      if (key.name === 'up' || key.name === 'k') {
        controller.commit(withModelsCursor(state, listCursor(rows.length, state.modelsCursor, -1)));
        return true;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const selected = rows[Math.min(state.modelsCursor, rows.length - 1)];
        if (selected !== undefined) {
          openModel(selected.key);
        }
        return true;
      }
      return false;
    }
    if (state.promptDetail?.origin === 'models') {
      return handlePromptDetailKey(key);
    }
    if (key.name === 'escape') {
      controller.commit(withModelDrillDown(state, null));
      return true;
    }
    const rows = state.modelPrompts.data?.rows.length ?? 0;
    if (key.name === 'down' || key.name === 'j') {
      controller.commit(withModelPromptsCursor(state, listCursor(rows, state.modelPromptsCursor, 1)));
      return true;
    }
    if (key.name === 'up' || key.name === 'k') {
      controller.commit(withModelPromptsCursor(state, listCursor(rows, state.modelPromptsCursor, -1)));
      return true;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const selected = state.modelPrompts.data?.rows[Math.min(state.modelPromptsCursor, rows - 1)];
      if (selected !== undefined) {
        openPromptDetail('models', selected.id);
      }
      return true;
    }
    return false;
  }

  /**
   * The detail is a scrollable page over the list it came from: Esc goes
   * back, ↑↓/jk move a line, PgUp/PgDn a page, g/G jump to either end.
   * The scroll is clamped here against the rendered line count so the
   * offset never runs past the last page.
   */
  function handlePromptDetailKey(key: TuiKeyEvent): boolean {
    const state = controller.getState();
    const detail = state.promptDetail;
    if (detail === null) {
      return false;
    }
    if (key.name === 'escape') {
      controller.commit(withPromptDetail(state, null));
      return true;
    }
    const model = detail.resource.data;
    if (model === null) {
      return false;
    }
    const bodyHeight = Math.max(1, shellBodyHeight(screen.height) - PROMPT_DETAIL_HEADER_LINES);
    const total = promptDetailLines(model, Math.max(20, screen.width)).length;
    const scrollTo = (target: number): boolean => {
      controller.commit(withPromptDetailScroll(state, clampDetailScroll(total, target, bodyHeight)));
      return true;
    };
    if (key.name === 'down' || key.name === 'j') {
      return scrollTo(detail.scroll + 1);
    }
    if (key.name === 'up' || key.name === 'k') {
      return scrollTo(detail.scroll - 1);
    }
    if (key.name === 'pagedown' || key.name === 'space') {
      return scrollTo(detail.scroll + bodyHeight);
    }
    if (key.name === 'pageup') {
      return scrollTo(detail.scroll - bodyHeight);
    }
    if (key.name === 'g' || key.name === 'home') {
      return scrollTo(0);
    }
    if (key.name === 'G' || key.name === 'end') {
      return scrollTo(total);
    }
    return false;
  }

  /**
   * Opens the detail for the highlighted prompt. Loaded outside the tab
   * loader like the lists are; a result is dropped when the user has
   * already closed the page or opened another prompt.
   */
  function openPromptDetail(origin: PromptDetailState['origin'], id: number): void {
    const stillWanted = (): boolean => {
      const detail = controller.getState().promptDetail;
      return detail !== null && detail.origin === origin && detail.id === id;
    };
    const put = (resource: ResourceState<PromptDetailViewModel>): void => {
      const state = controller.getState();
      if (state.promptDetail === null || !stillWanted()) {
        return;
      }
      controller.commit(withPromptDetail(state, { ...state.promptDetail, resource }));
    };
    controller.commit(
      withPromptDetail(controller.getState(), {
        origin,
        id,
        resource: { phase: 'loading', data: null, error: null, updatedAtUtc: null, invalidated: false },
        scroll: 0,
      }),
    );
    void (async () => {
      try {
        const detail = await options.dataSource.loadPromptDetail(id);
        put(
          detail === null
            ? {
                phase: 'error',
                data: null,
                error: 'this prompt is no longer in the ledger',
                updatedAtUtc: null,
                invalidated: false,
              }
            : {
                phase: 'ready',
                data: toPromptDetailViewModel(detail),
                error: null,
                updatedAtUtc: null,
                invalidated: false,
              },
        );
      } catch (error) {
        put({
          phase: 'error',
          data: null,
          error: sanitizeTerminalLine(error instanceof Error ? error.message : String(error)),
          updatedAtUtc: null,
          invalidated: false,
        });
      }
    })();
  }

  function openModel(model: string): void {
    controller.commit(withModelDrillDown(controller.getState(), model));
    void loadModelPrompts(model);
  }

  /**
   * Overview chart day selection: ↓ enters on the newest day, ←/→ walk
   * the data days (calendar gaps are skipped — an empty day has nothing
   * to show), ↑/Esc leave. While a day is selected ←/→ are consumed, so
   * tab switching falls back to Tab and the digits.
   */
  function handleOverviewKey(key: TuiKeyEvent): boolean {
    const state = controller.getState();
    const points = state.overview.data?.chart.points ?? [];
    if (points.length === 0) {
      return false;
    }
    const selected = state.overviewSelectedDate;
    if (selected === null) {
      if (key.name === 'down' || key.name === 'j') {
        selectOverviewDate(points[points.length - 1]?.date ?? null);
        return true;
      }
      return false;
    }
    if (key.name === 'escape' || key.name === 'up' || key.name === 'k') {
      controller.commit(withOverviewSelectedDate(state, null));
      return true;
    }
    // a reload may have dropped the selected day (retention); walking
    // from the newest day keeps the keys responsive instead of dead
    const found = points.findIndex((point) => point.date === selected);
    const current = found < 0 ? points.length - 1 : found;
    if (key.name === 'left' || key.name === 'h') {
      selectOverviewDate(points[Math.max(0, current - 1)]?.date ?? null);
      return true;
    }
    if (key.name === 'right' || key.name === 'l') {
      selectOverviewDate(points[Math.min(points.length - 1, current + 1)]?.date ?? null);
      return true;
    }
    // ↓ entered the selection; a repeat should not fall through to a
    // global binding and must not move anything either
    return key.name === 'down' || key.name === 'j';
  }

  function selectOverviewDate(date: string | null): void {
    if (date === null) {
      return;
    }
    const state = controller.getState();
    if (state.overviewSelectedDate === date) {
      return;
    }
    controller.commit(withOverviewSelectedDate(state, date));
    void loadDayDetail(date);
  }

  /** Same discard rule as the prompt lists: a result for a day the user
   * has already left must never land under the new day's header. */
  async function loadDayDetail(date: string): Promise<void> {
    const stillWanted = (): boolean => controller.getState().overviewSelectedDate === date;
    const put = (resource: ResourceState<DayDetailViewModel>): void => {
      if (stillWanted()) {
        controller.commit({ ...controller.getState(), overviewDayDetail: resource });
      }
    };
    put({ phase: 'loading', data: null, error: null, updatedAtUtc: null, invalidated: false });
    try {
      const result = await options.dataSource.loadDayReport(date);
      put({
        phase: 'ready',
        data: toDayDetailViewModel(date, result.agents, result.modelsByAgent),
        error: null,
        updatedAtUtc: null,
        invalidated: false,
      });
    } catch (error) {
      put({
        phase: 'error',
        data: null,
        error: sanitizeTerminalLine(error instanceof Error ? error.message : String(error)),
        updatedAtUtc: null,
        invalidated: false,
      });
    }
  }

  /**
   * Prompt lists are loaded outside the tab loader: both are driven by a
   * user action rather than a refresh cycle, and a result must be
   * discarded when the user has already moved on to a different model or
   * query — otherwise a slow query overwrites a newer one.
   */
  async function loadPromptsInto(
    target: 'search' | 'model',
    token: string,
    load: () => Promise<PromptListResult>,
  ): Promise<void> {
    const stillWanted = (): boolean => {
      const state = controller.getState();
      return target === 'search' ? state.searchQuery === token : state.modelDrillDown === token;
    };
    const put = (resource: ResourceState<PromptsViewModel>): void => {
      if (!stillWanted()) {
        return;
      }
      const state = controller.getState();
      controller.commit(
        target === 'search'
          ? withTabResource(state, 'search', resource)
          : { ...state, modelPrompts: resource },
      );
    };
    put({ phase: 'loading', data: null, error: null, updatedAtUtc: null, invalidated: false });
    try {
      const result = await load();
      put({
        phase: 'ready',
        data: toPromptsViewModel(
          result,
          target === 'search' ? `matches for "${token}"` : `prompts for ${token}`,
        ),
        error: null,
        updatedAtUtc: null,
        invalidated: false,
      });
    } catch (error) {
      put({
        phase: 'error',
        data: null,
        error: sanitizeTerminalLine(error instanceof Error ? error.message : String(error)),
        updatedAtUtc: null,
        invalidated: false,
      });
    }
  }

  async function loadModelPrompts(model: string): Promise<void> {
    await loadPromptsInto('model', model, () =>
      options.dataSource.loadPrompts({ model, search: null }),
    );
  }

  /**
   * Clicks select rather than act: opening a model or switching an
   * account still takes a deliberate Enter, so a stray click cannot
   * start something irreversible.
   */
  function handleBodyClick(bodyRow: number, bodyHeight: number, column: number): boolean {
    const state = controller.getState();
    if (state.activeTab === 'overview') {
      const model = state.overview.data;
      if (model === null) {
        return false;
      }
      const date = overviewDateAtClick(
        model,
        chartStyle,
        screen.width,
        bodyHeight,
        bodyRow,
        column,
        state.overviewSelectedDate,
      );
      if (date !== null) {
        selectOverviewDate(date);
        return true;
      }
      return false;
    }
    const promptClick = (rowCount: number, cursor: number, linesAbove: number): number | null =>
      promptIndexAtLine(
        promptWindowStart(rowCount, cursor, bodyHeight - linesAbove - PROMPT_LIST_HEADER_LINES)
          .firstVisible,
        linesAbove,
        bodyRow,
        rowCount,
      );
    // a detail page has no clickable rows; the list under it must not move
    if (state.promptDetail?.origin === state.activeTab) {
      return false;
    }
    if (state.activeTab === 'search') {
      const rows = state.search.data?.rows.length ?? 0;
      // the query line and its blank sit above the list header
      const index = promptClick(rows, state.searchCursor, 2);
      if (index !== null) {
        controller.commit(withSearchCursor(state, index));
        return true;
      }
      return false;
    }
    if (state.activeTab === 'models') {
      if (state.modelDrillDown !== null) {
        const rows = state.modelPrompts.data?.rows.length ?? 0;
        const index = promptClick(rows, state.modelPromptsCursor, 2);
        if (index !== null) {
          controller.commit(withModelPromptsCursor(state, index));
          return true;
        }
        return false;
      }
      const rows = sortBreakdownRows(state.models.data?.rows ?? [], sortSpecFor(state, 'models'));
      // mirror the renderer's cursor-following window: the clicked line
      // maps to start + offset, and the "… N above" marker is not a row
      const tableRows = Math.max(3, bodyHeight - 8);
      const { start, hasAboveLine } = tableWindow(rows.length, state.modelsCursor, tableRows);
      const dataTop = MODELS_TABLE_HEADER_LINES + (hasAboveLine ? 1 : 0);
      const offset = bodyRow - dataTop;
      const visibleCount = Math.min(rows.length - start, Math.max(1, tableRows));
      if (offset >= 0 && offset < visibleCount) {
        controller.commit(withModelsCursor(state, start + offset));
        return true;
      }
      return false;
    }
    // Accounts cards vary in height, so clicking there only focuses the
    // tab; the wheel and arrow keys move its selection.
    return false;
  }

  async function runConfirmed(topic: ConfirmTopic, payload: string): Promise<void> {
    if (topic === 'account-add') {
      await runAction('Add account', () => options.dataSource.addCurrentAccount());
      return;
    }
    if (topic === 'account-switch') {
      const [agent, accountId] = splitAccountPayload(payload);
      await runAction('Switch account', () => options.dataSource.switchToAccount(agent, accountId));
      return;
    }
    if (topic === 'account-detach') {
      await runAction('Detach codex login', () => options.dataSource.detachCodexAccount());
      return;
    }
    if (topic === 'daemon-install') {
      await runAction('Background collection', () => options.dataSource.installDaemon(), 'doctor');
      return;
    }
    if (topic === 'daemon-uninstall') {
      await runAction('Background collection', () => options.dataSource.uninstallDaemon(), 'doctor');
      return;
    }
    if (topic === 'ledger-compact') {
      await runAction('Compact ledger', () => options.dataSource.compactLedger(), 'doctor');
      return;
    }
    const [agent, accountId] = splitAccountPayload(payload);
    await runAction('Remove account', () => options.dataSource.removeAccount(agent, accountId));
  }

  /** Payload built as `<agent>:<accountId>`; neither side contains ":". */
  function splitAccountPayload(payload: string): [string, string] {
    const separator = payload.indexOf(':');
    return separator < 0
      ? ['claude-code', payload]
      : [payload.slice(0, separator), payload.slice(separator + 1)];
  }

  /**
   * Account mutations block the UI behind a busy notice: they touch
   * credential stores, and letting the user start a second one mid-flight
   * is how backups get overwritten.
   */
  async function runAction(
    title: string,
    operation: () => Promise<string>,
    reload: 'accounts' | 'doctor' = 'accounts',
  ): Promise<void> {
    notice(title, 'working…', true);
    try {
      const message = await operation();
      notice(title, message, false);
    } catch (error) {
      notice(title, error instanceof Error ? error.message : String(error), false);
    }
    controller.commit(withInvalidatedTabs(controller.getState(), [reload]));
    loader?.loadIfNeeded(reload);
  }

  /** Clears the first-run notice as soon as the initial scan reports back. */
  function dismissNoticeWhenScanned(): void {
    const timer = setInterval(() => {
      const state = controller.getState();
      if (state.refresh.scanStatus === 'running' || state.refresh.lastCompletedAtUtc === null) {
        return;
      }
      clearInterval(timer);
      if (state.overlay?.kind !== 'notice' || !state.overlay.busy) {
        return;
      }
      if (state.refresh.scanStatus === 'error') {
        notice(
          'First launch',
          'Could not import your agent logs. Press r to retry, or check tab 6 (Doctor).',
          false,
        );
        return;
      }
      controller.setOverlay(null);
    }, 200);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /**
   * Quota is a couple of HTTP reads; scanning walks thousands of files.
   * Tying them to one interval meant quota froze whenever auto-refresh
   * was off, so it gets its own poll — only while the tab that shows it
   * is on screen, and cheap because the core throttle de-duplicates.
   */
  function startQuotaPolling(): void {
    const timer = setInterval(() => {
      const state = controller.getState();
      if (state.closing || state.activeTab !== 'accounts' || state.overlay !== null) {
        return;
      }
      controller.commit(withInvalidatedTabs(state, ['accounts']));
      loader?.loadIfNeeded('accounts');
    }, options.quotaPollMs ?? QUOTA_POLL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    quotaTimer = timer;
  }

  loader = new TabLoader(controller, options.dataSource);
  scheduler = new RefreshScheduler({
    controller,
    dataSource: options.dataSource,
    loader,
    intervalSeconds: initialInterval,
  });

  return {
    async run(): Promise<void> {
      running = true;
      controller.start();
      startQuotaPolling();
      // 'updated Ns ago' and the spinner track wall time; without a
      // tick they freeze until the next state commit (audit CX-33)
      footerTicker = setInterval(() => controller.redraw(), 1000);
      if (options.firstRun === true) {
        // the first import walks every agent log on the machine, so say
        // so rather than leaving an empty dashboard that looks broken
        notice(
          'First launch',
          'Importing your local agent logs.\nThis happens once; later launches only collect what changed.\nq quits — the import resumes on the next launch.',
          true,
        );
        dismissNoticeWhenScanned();
      }
      scheduler?.start();
      await controller.done;
      scheduler?.stop();
      if (quotaTimer !== null) {
        clearInterval(quotaTimer);
        quotaTimer = null;
      }
      if (footerTicker !== null) {
        clearInterval(footerTicker);
        footerTicker = null;
      }
      running = false;
    },
    stop(): void {
      controller.stop();
      if (quotaTimer !== null) {
        clearInterval(quotaTimer);
        quotaTimer = null;
      }
      if (footerTicker !== null) {
        clearInterval(footerTicker);
        footerTicker = null;
      }
      if (running) {
        scheduler?.stop();
      }
    },
  };
}
