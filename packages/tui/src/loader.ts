import type { TuiController } from './controller.ts';
import type { TuiDataSource } from './data-source.ts';
import { withTabResource } from './state.ts';
import type { TuiState } from './state.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import { toBreakdownViewModel } from './view-model/breakdown.ts';
import { toOverviewViewModel } from './view-model/overview.ts';
import { toAccountsTabViewModel } from './view-model/accounts.ts';
import { toDoctorViewModel } from './view-model/doctor.ts';
import { toPromptsViewModel } from './view-model/prompts.ts';
import type { TuiTab } from './types.ts';

type TabResource = TuiState[TuiTab];
type TabData = NonNullable<TabResource['data']>;

/**
 * Minimal per-tab lazy loading until P6 replaces it with coordinated
 * refresh: loads a tab's resource when it is idle or invalidated, keeps
 * the previous data on failure, and never runs the same tab twice
 * concurrently.
 */
export class TabLoader {
  private readonly inFlight = new Set<TuiTab>();
  /** Bumped after every successful scan; loads started before the bump are stale. */
  private scanEpoch = 0;

  constructor(
    private readonly controller: TuiController,
    private readonly dataSource: TuiDataSource,
    private readonly nowUtc: () => number = (): number => Math.floor(Date.now() / 1000),
  ) {}

  /** Called by the refresh scheduler when a scan committed new rows. */
  markScanCompleted(): void {
    this.scanEpoch += 1;
  }

  loadIfNeeded(tab: TuiTab): void {
    const resource = this.controller.getState()[tab];
    if (this.inFlight.has(tab) || resource.phase === 'loading') {
      return;
    }
    if (resource.phase === 'ready' && !resource.invalidated) {
      return;
    }
    this.inFlight.add(tab);
    const epochAtStart = this.scanEpoch;
    this.commitResource(tab, { ...resource, phase: 'loading' });
    void this.load(tab)
      .then((data) => {
        // a scan finished while this query ran: the result is pre-scan,
        // so it stays marked invalidated and a follow-up load runs below
        const stale = this.scanEpoch !== epochAtStart;
        this.commitResource(tab, {
          phase: 'ready',
          data,
          error: null,
          updatedAtUtc: this.nowUtc(),
          invalidated: stale,
        } as TabResource);
      })
      .catch((error: unknown) => {
        const previous = this.controller.getState()[tab];
        this.commitResource(tab, {
          ...previous,
          phase: 'error',
          error: sanitizeTerminalLine(error instanceof Error ? error.message : String(error)),
        });
      })
      .finally(() => {
        this.inFlight.delete(tab);
        if (this.scanEpoch !== epochAtStart) {
          this.loadIfNeeded(tab);
        }
      });
  }

  private async load(tab: TuiTab): Promise<TabData> {
    if (tab === 'accounts') {
      return toAccountsTabViewModel(await this.dataSource.loadAccounts());
    }
    if (tab === 'search') {
      // the session drives searching; entering the tab must not list
      // every prompt in the ledger just because nothing was typed yet
      return toPromptsViewModel({ rows: [], truncated: false, warnings: [] }, '');
    }
    if (tab === 'doctor') {
      return toDoctorViewModel(await this.dataSource.loadDoctorChecks());
    }
    if (tab === 'agents') {
      return toBreakdownViewModel('agent', await this.dataSource.loadReport('agent'));
    }
    if (tab === 'models') {
      return toBreakdownViewModel('model', await this.dataSource.loadReport('model'));
    }
    return toOverviewViewModel(await this.dataSource.loadReport('day'));
  }

  private commitResource(tab: TuiTab, resource: TabResource): void {
    this.controller.commit(withTabResource(this.controller.getState(), tab, resource));
  }
}
