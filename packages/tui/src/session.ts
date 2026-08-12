/**
 * Wires the TUI together: tabs, refresh, pickers, and the account
 * actions. The CLI only parses flags and hands this a screen and a data
 * source, so every interaction lives in one place instead of being
 * split between the command and the controller.
 */
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
  withSearchCursor,
  withModelsCursor,
  withSearchQuery,
  withTabResource,
  sortSpecFor,
} from './state.ts';
import { MONO_THEME, THEMES, resolveTheme } from './theme.ts';
import type { ResolvedTheme } from './theme.ts';
import type { ChartGlyphMode } from './components/daily-block-chart.ts';
import type { ResourceState, TuiKeyEvent, TuiScreen } from './types.ts';
import type { PromptListResult } from '@llmtally/core/report/prompts.ts';
import type { PromptsViewModel } from './view-model/prompts.ts';
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
import { makeOverviewTabView } from './views/overview.ts';

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
  readonly chartMode: ChartGlyphMode;
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

/** Tracks the chosen theme and resolves it once per theme, not per frame. */
class ThemeSelection {
  readonly #resolved = new Map<string, ResolvedTheme>();
  #name: string;

  constructor(name: string, private readonly monoForced: boolean) {
    this.#name = name;
    for (const theme of THEMES) {
      this.#resolved.set(theme.name, resolveTheme(theme));
    }
  }

  get name(): string {
    return this.#name;
  }

  select(name: string): void {
    if (name === MONO_THEME_NAME || this.#resolved.has(name)) {
      this.#name = name;
    }
  }

  current(): ResolvedTheme {
    if (this.monoForced || this.#name === MONO_THEME_NAME) {
      return MONO_THEME;
    }
    return this.#resolved.get(this.#name) ?? MONO_THEME;
  }

  options(): PickerOption[] {
    const options: PickerOption[] = THEMES.map((theme) => ({
      id: theme.name,
      label: theme.name,
      hint: theme.name === this.#name ? 'current' : undefined,
    }));
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
    options.themeName ?? remembered.theme ?? 'default',
    options.monoForced,
  );
  const initialInterval =
    options.refreshSeconds !== undefined ? options.refreshSeconds : (remembered.autoRefreshSeconds ?? null);

  let loader: TabLoader | null = null;
  let scheduler: RefreshScheduler | null = null;
  let running = false;
  let quotaTimer: ReturnType<typeof setInterval> | null = null;

  const screen = await options.createScreen(() => theme.current());
  const controller = new TuiController({
    screen,
    views: {
      overview: makeOverviewTabView(options.chartMode),
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
    onInputSubmit: (value) => {
      runSearch(value);
    },
    onBodyClick: (bodyRow, bodyHeight) => handleBodyClick(bodyRow, bodyHeight),
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
    }
  }

  function applyPick(topic: PickerTopic, optionId: string): void {
    if (topic === 'theme') {
      theme.select(optionId);
      const error = prefs.save({ theme: optionId });
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
        message:
          'Stores the logins Claude Code, Codex, and OpenCode are using right now.\n' +
          '\n' +
          'To add a different account, sign in with it first:\n' +
          '  · claude-code: run "claude" and use /login\n' +
          '  · codex: press d here FIRST, then run "codex login"\n' +
          '  · opencode: run "opencode auth login"\n' +
          'then come back here and press n.\n' +
          '\n' +
          'Codex is the odd one out: "codex login" revokes whatever login\n' +
          'auth.json still holds, which kills the account you just stored.\n' +
          'Pressing d first stores it and moves the file out of the way, so\n' +
          'there is nothing left to revoke.\n' +
          '\n' +
          'Store the current logins?',
        payload: '',
      });
      return true;
    }
    if (key.name === 'd') {
      controller.setOverlay({
        kind: 'confirm',
        topic: 'account-detach',
        title: 'Detach codex login',
        message:
          'Stores the codex login that is active now, then signs codex out\n' +
          'locally. Nothing is revoked — the login stays usable and you can\n' +
          'bring it back here with s.\n' +
          '\n' +
          'Do this before "codex login" when adding a second codex account:\n' +
          'that command revokes whatever auth.json still holds.\n' +
          '\n' +
          'Detach the current codex login?',
        payload: '',
      });
      return true;
    }
    const row = selectedRow();
    if ((key.name === 's' || key.name === 'return' || key.name === 'enter') && row !== undefined) {
      if (row.accountId === null || row.isActive) {
        return true;
      }
      controller.setOverlay({
        kind: 'confirm',
        topic: 'account-switch',
        title: 'Switch account',
        message: `Switch ${row.agent} to ${row.label}?`,
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

  /** Returns true when the Doctor tab consumed the key. */
  function handleDoctorKey(key: TuiKeyEvent): boolean {
    if (key.name === 'D') {
      controller.setOverlay({
        kind: 'confirm',
        topic: 'daemon-install',
        title: 'Background collection',
        message: 'Install the launchd agent that collects usage hourly?',
        payload: '',
      });
      return true;
    }
    if (key.name === 'U') {
      controller.setOverlay({
        kind: 'confirm',
        topic: 'daemon-uninstall',
        title: 'Background collection',
        message: 'Remove the launchd agent?',
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
    if (key.name === '/') {
      controller.setOverlay({
        kind: 'input',
        title: 'Search prompts',
        prompt: 'Matches whole words in stored prompt text.',
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
    return false;
  }

  function openModel(model: string): void {
    controller.commit(withModelDrillDown(controller.getState(), model));
    void loadModelPrompts(model);
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
  function handleBodyClick(bodyRow: number, bodyHeight: number): boolean {
    const state = controller.getState();
    const promptClick = (rowCount: number, cursor: number, linesAbove: number): number | null =>
      promptIndexAtLine(
        promptWindowStart(rowCount, cursor, bodyHeight - linesAbove - PROMPT_LIST_HEADER_LINES)
          .firstVisible,
        linesAbove,
        bodyRow,
        rowCount,
      );
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
      const index = bodyRow - MODELS_TABLE_HEADER_LINES;
      if (index >= 0 && index < rows.length) {
        controller.commit(withModelsCursor(state, index));
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
      if (options.firstRun === true) {
        // the first import walks every agent log on the machine, so say
        // so rather than leaving an empty dashboard that looks broken
        notice(
          'First launch',
          'Importing your local agent logs.\nThis happens once; later launches only collect what changed.',
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
      running = false;
    },
    stop(): void {
      controller.stop();
      if (quotaTimer !== null) {
        clearInterval(quotaTimer);
        quotaTimer = null;
      }
      if (running) {
        scheduler?.stop();
      }
    },
  };
}
