import { ScanLockError } from '@llmtally/core/scan/lock.ts';
import type { TuiController } from './controller.ts';
import type { TuiDataSource } from './data-source.ts';
import type { TabLoader } from './loader.ts';
import { withInvalidatedTabs, withRefresh } from './state.ts';
import type { RefreshReason, ScanRefreshStatus } from './types.ts';

export interface RefreshSchedulerOptions {
  readonly controller: TuiController;
  readonly dataSource: TuiDataSource;
  readonly loader: TabLoader;
  /** Initial auto-refresh interval; null/omitted = off (the default). */
  readonly intervalSeconds?: number | null;
  readonly nowUtc?: () => number;
}

/** The `a` key cycles through these (label shown in the footer). */
export const AUTO_INTERVALS: readonly (number | null)[] = [null, 30, 60, 300, 600];

export function autoIntervalLabel(seconds: number | null): string {
  if (seconds === null) {
    return 'off';
  }
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

/**
 * Coordinates scan + reload cycles:
 * - single-flight: one cycle at a time, extra manual requests coalesce
 *   into a single pending bit;
 * - a daemon holding the scan lock is non-fatal — the cycle continues
 *   with the current ledger and the footer shows "scan busy";
 * - after a successful scan every report tab is invalidated but only
 *   the active tab reloads; others reload lazily on tab change;
 * - the next interval is scheduled after the cycle completes (no
 *   overlapping setInterval ticks).
 */
export class RefreshScheduler {
  private readonly controller: TuiController;
  private readonly dataSource: TuiDataSource;
  private readonly loader: TabLoader;
  private intervalSeconds: number | null;
  private readonly nowUtc: () => number;
  private inFlight = false;
  private pending = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RefreshSchedulerOptions) {
    this.controller = options.controller;
    this.dataSource = options.dataSource;
    this.loader = options.loader;
    this.intervalSeconds = options.intervalSeconds ?? null;
    this.nowUtc = options.nowUtc ?? ((): number => Math.floor(Date.now() / 1000));
  }

  /** Runs the startup scan once; auto-refresh only continues if enabled. */
  start(): void {
    this.commitRefresh({ autoIntervalSeconds: this.intervalSeconds });
    void this.run('startup');
  }

  /** Sets the interval directly (null turns auto-refresh off). */
  setAutoInterval(seconds: number | null): void {
    if (this.stopped) {
      return;
    }
    this.intervalSeconds = seconds;
    this.commitRefresh({ autoIntervalSeconds: seconds });
    if (!this.inFlight) {
      this.schedule();
    }
  }

  /** Advances off -> 30s -> 1m -> 5m -> 10m -> off and reschedules. */
  cycleAutoInterval(): void {
    if (this.stopped) {
      return;
    }
    const index = AUTO_INTERVALS.indexOf(this.intervalSeconds);
    this.intervalSeconds = AUTO_INTERVALS[(index + 1) % AUTO_INTERVALS.length] ?? null;
    this.commitRefresh({ autoIntervalSeconds: this.intervalSeconds });
    if (!this.inFlight) {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped || this.intervalSeconds === null) {
      return;
    }
    this.timer = setTimeout(
      () => {
        void this.run('interval');
      },
      Math.max(10, this.intervalSeconds * 1000),
    );
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /** Called on the `r` key; never starts a second concurrent cycle. */
  requestManual(): void {
    if (this.stopped) {
      return;
    }
    if (this.inFlight) {
      this.pending = true;
      this.commitRefresh({ pending: true });
      return;
    }
    void this.run('manual');
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private commitRefresh(patch: Parameters<typeof withRefresh>[1]): void {
    this.controller.commit(withRefresh(this.controller.getState(), patch));
  }

  private async run(reason: RefreshReason): Promise<void> {
    if (this.inFlight || this.stopped) {
      return;
    }
    this.inFlight = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.commitRefresh({ inFlight: true, pending: false, reason, scanStatus: 'running' });

    let scanStatus: ScanRefreshStatus;
    try {
      await this.dataSource.scan();
      scanStatus = 'ok';
    } catch (error) {
      scanStatus = error instanceof ScanLockError ? 'busy' : 'error';
    }

    if (this.stopped) {
      this.inFlight = false;
      return;
    }
    let state = this.controller.getState();
    if (scanStatus === 'ok') {
      // quota is invalidated too so a visit after the cycle re-reads it
      this.loader.markScanCompleted();
      state = withInvalidatedTabs(state, ['overview', 'agents', 'models', 'accounts', 'search', 'doctor']);
    } else {
      // busy/error: the daemon may have committed rows meanwhile, so the
      // active tab still re-queries the current ledger (and quota re-reads)
      state = withInvalidatedTabs(state, [state.activeTab]);
    }
    state = withRefresh(state, {
      inFlight: false,
      reason: null,
      scanStatus,
      lastCompletedAtUtc: this.nowUtc(),
    });
    this.controller.commit(state);
    this.loader.loadIfNeeded(this.controller.getState().activeTab);
    this.inFlight = false;

    if (this.pending) {
      this.pending = false;
      void this.run('manual');
      return;
    }
    this.schedule();
  }
}
