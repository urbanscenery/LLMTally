import { describe, expect, test } from 'bun:test';

import type { PromptListResult } from '@llmtally/core/report/prompts.ts';

import type { AccountsInput } from '@llmtally/tui/view-model/accounts.ts';
import type { TuiDataSource } from '@llmtally/tui/data-source.ts';
import { createTuiSession } from '@llmtally/tui/session.ts';
import type { ReportGroupBy, ReportSummary } from '@llmtally/core/report/types.ts';
import type { ScanSummary } from '@llmtally/core/scan/types.ts';
import { FakeScreen } from './helpers.ts';

const NOW = 1_800_000_000;

function scanSummary(): ScanSummary {
  return {
    agent: null,
    databasePath: '/tmp/x.db',
    discoveredFiles: 0,
    scannedFiles: 0,
    missingFiles: 0,
    insertedRows: 0,
    ignoredRows: 0,
    malformedLines: 0,
    pendingTails: 0,
    warnings: [],
    warningCounts: {},
    warningTotal: 0,
    startedAtUtc: NOW,
    finishedAtUtc: NOW,
  };
}

function emptyReport(groupBy: ReportGroupBy): ReportSummary {
  return {
    command: 'report',
    databasePath: '/tmp/x.db',
    groupBy,
    agent: null,
    range: { fromDate: null, toDate: null },
    buckets: [],
    totals: {
      key: 'total',
      rowCount: 0,
      promptCount: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, reasoningTokens: 0 },
      spendCost: { basis: 'spend', usd: null, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 0, warnings: [] },
      quotaCost: { basis: 'quota', usd: null, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 0, warnings: [] },
      unpricedRows: 0,
      unknownRows: 0,
      unknownUsd: 0,
      unpricedModels: [],
    },
    pricing: { status: 'fresh', asOfUtc: NOW, sources: [], warnings: [] },
  };
}

function makeDataSource(scan: () => Promise<ScanSummary>): TuiDataSource {
  return {
    scan,
    async loadAccounts(): Promise<AccountsInput> {
      return { snapshots: [], vault: [], discovered: [], activeAccountId: null };
    },
    async loadReport(groupBy: ReportGroupBy): Promise<ReportSummary> {
      return emptyReport(groupBy);
    },
    async loadDayReport(): Promise<{
      agents: ReportSummary;
      modelsByAgent: Record<string, ReportSummary>;
    }> {
      return { agents: emptyReport('agent'), modelsByAgent: {} };
    },
    async loadDoctorChecks() {
      return [];
    },
    async addCurrentAccount() {
      return 'added';
    },
    async removeAccount() {
      return 'removed';
    },
    async switchToAccount() {
      return 'switched';
    },
    async detachCodexAccount() {
      return 'detached';
    },
    invalidateQuotaCache(): void {
      // nothing cached in tests
    },
    async loadPrompts(): Promise<PromptListResult> {
      return { rows: [], truncated: false, warnings: [] };
    },
    async installDaemon() {
      return 'installed';
    },
    async uninstallDaemon() {
      return 'uninstalled';
    },
    async compactLedger() {
      return 'compacted';
    },
  };
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function preferences() {
  return {
    load: () => ({
      theme: null,
      autoRefreshSeconds: undefined,
      paintBackground: undefined,
      chartStyle: null,
    }),
    save: () => null,
  };
}

describe('first launch', () => {
  test('explains the initial import while it runs, then clears it', async () => {
    // Arrange — a scan slow enough to observe
    const screen = new FakeScreen();
    let released = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      released = () => {
        resolve();
      };
    });
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: makeDataSource(async () => {
        await gate;
        return scanSummary();
      }),
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: true,
      preferences: preferences(),
    });

    // Act
    const done = session.run();
    await settle();
    const duringScan = screen.frames.at(-1)?.join('\n') ?? '';
    released();
    await settle(400);
    const afterScan = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert
    expect(duringScan).toContain('First launch');
    expect(duringScan).toContain('Importing your local agent logs');
    expect(afterScan).not.toContain('First launch');
  });

  test('a failed first import says so instead of leaving an empty dashboard', async () => {
    // Arrange
    const screen = new FakeScreen();
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: makeDataSource(async () => {
        throw new Error('disk on fire');
      }),
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: true,
      preferences: preferences(),
    });

    // Act
    const done = session.run();
    await settle(400);
    const frame = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert
    expect(frame).toContain('Could not import your agent logs');
  });

  test('a later launch starts straight on the dashboard', async () => {
    // Arrange
    const screen = new FakeScreen();
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: makeDataSource(async () => scanSummary()),
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
    });

    // Act
    const done = session.run();
    await settle(150);
    const frame = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert
    expect(frame).not.toContain('First launch');
  });
});

describe('models drill-down and search', () => {
  function reportWithModels(groupBy: ReportGroupBy): ReportSummary {
    const base = emptyReport(groupBy);
    if (groupBy !== 'model') {
      return base;
    }
    const bucket = (key: string, rows: number) => ({
      key,
      rowCount: rows,
      promptCount: rows,
      tokens: { inputTokens: rows, outputTokens: 0, cacheWrite: 0, cacheRead: 0, reasoningTokens: 0 },
      spendCost: { basis: 'spend' as const, usd: null, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 0, warnings: [] },
      quotaCost: { basis: 'quota' as const, usd: 1, pricedSubtotalUsd: 1, pricedRows: rows, unpricedRows: 0, warnings: [] },
      unpricedRows: 0,
      unknownRows: 0,
      unknownUsd: 0,
      unpricedModels: [],
    });
    return { ...base, buckets: [bucket('model-a', 10), bucket('model-b', 5)] };
  }

  async function start(promptCalls: string[] = []) {
    const screen = new FakeScreen();
    const source = makeDataSource(async () => scanSummary());
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: {
        ...source,
        loadReport: async (groupBy: ReportGroupBy) => reportWithModels(groupBy),
        loadPrompts: async (filter: { model: string | null; search: string | null }) => {
          promptCalls.push(`${filter.model ?? ''}|${filter.search ?? ''}`);
          return {
            rows: [
              {
                id: 1,
                tsUtc: NOW,
                agent: 'claude-code',
                model: filter.model ?? 'any',
                effort: null,
                tokens: { inputTokens: 10, outputTokens: 2, cacheWrite: 0, cacheRead: 0, reasoningTokens: 0 },
                nature: 'quota' as const,
                costUsd: 0.5,
                text: 'hello prompt',
                calls: 3,
                isSidechain: false,
              },
            ],
            truncated: false,
            warnings: [],
          };
        },
      },
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
    });
    const done = session.run();
    await settle(120);
    return { screen, session, done };
  }

  test('the cursor moves and Enter opens the model under it', async () => {
    // Arrange
    const promptCalls: string[] = [];
    const { screen, session, done } = await start(promptCalls);

    // Act — go to Models, move down one row, open it
    screen.pressKey('4');
    await settle(80);
    screen.pressKey('j');
    screen.pressKey('return');
    await settle(120);
    const frame = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert — the second row by the table's own sort order
    expect(promptCalls).toEqual(['model-b|']);
    expect(frame).toContain('prompts for model-b');
    expect(frame).toContain('hello prompt');
  });

  test('Esc returns from the prompt list to the table', async () => {
    // Arrange
    const { screen, session, done } = await start();
    screen.pressKey('4');
    await settle(80);
    screen.pressKey('return');
    await settle(120);

    // Act
    screen.pressKey('escape');
    await settle(40);
    const frame = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert
    expect(frame).not.toContain('prompts for');
    expect(frame).toContain('model-a');
  });

  test('a normalized shift+d reaches the Doctor daemon action', async () => {
    // Arrange — production OpenTUI reports Shift-D as name:'d',
    // shift:true; the literal 'D' never arrives from a real terminal
    const { screen, session, done } = await start();

    // Act — Doctor tab, then the normalized keypress
    screen.pressKey('6');
    await settle(80);
    screen.pressKey('d', { shift: true });
    await settle(40);
    const frame = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert — the install confirmation opened
    expect(frame).toContain('Background collection');
    expect(frame).toContain('hourly scans');
  });

  test('entering the search tab does not list every prompt', async () => {
    // Arrange
    const promptCalls: string[] = [];
    const { screen, session, done } = await start(promptCalls);

    // Act
    screen.pressKey('5');
    await settle(80);
    const frame = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert — an empty query must not run an unfiltered query
    expect(promptCalls).toEqual([]);
    expect(frame).toContain('press / to type a query');
  });

  test('typing a query searches and shows the term that produced it', async () => {
    // Arrange
    const promptCalls: string[] = [];
    const { screen, session, done } = await start(promptCalls);
    screen.pressKey('5');
    await settle(60);

    // Act
    screen.pressKey('/');
    for (const character of 'abc') {
      screen.pressKey(character);
    }
    screen.pressKey('return');
    await settle(120);
    const frame = screen.frames.at(-1)?.join('\n') ?? '';
    session.stop();
    await done;

    // Assert
    expect(promptCalls).toEqual(['|abc']);
    expect(frame).toContain('matches for "abc"');
  });
});

describe('quota freshness', () => {
  test('the accounts tab re-reads on its own, not only with the scan cycle', async () => {
    // Arrange — auto-refresh off, which is the default
    const screen = new FakeScreen();
    let accountLoads = 0;
    const source = makeDataSource(async () => scanSummary());
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: {
        ...source,
        loadAccounts: async () => {
          accountLoads += 1;
          return { snapshots: [], vault: [], discovered: [], activeAccountId: null };
        },
      },
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
      quotaPollMs: 60,
    });

    // Act — sit on the Accounts tab
    const done = session.run();
    screen.pressKey('2');
    await settle(260);
    session.stop();
    await done;

    // Assert — more than the single load the tab switch caused
    expect(accountLoads).toBeGreaterThan(1);
  });

  test('polling stops while another tab is showing', async () => {
    // Arrange
    const screen = new FakeScreen();
    let accountLoads = 0;
    const source = makeDataSource(async () => scanSummary());
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: {
        ...source,
        loadAccounts: async () => {
          accountLoads += 1;
          return { snapshots: [], vault: [], discovered: [], activeAccountId: null };
        },
      },
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
      quotaPollMs: 60,
    });

    // Act — stay on Overview
    const done = session.run();
    await settle(260);
    session.stop();
    await done;

    // Assert — no network reads for a tab nobody is looking at
    expect(accountLoads).toBe(0);
  });

  test('manual refresh drops the quota cache so r really re-reads', async () => {
    // Arrange
    const screen = new FakeScreen();
    let invalidations = 0;
    const source = makeDataSource(async () => scanSummary());
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: {
        ...source,
        invalidateQuotaCache: () => {
          invalidations += 1;
        },
      },
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
    });

    // Act
    const done = session.run();
    await settle(60);
    screen.pressKey('r');
    await settle(60);
    session.stop();
    await done;

    // Assert
    expect(invalidations).toBe(1);
  });
});

describe('add-account login guidance', () => {
  test('pressing n explains how to log in before anything is stored', async () => {
    // Arrange
    const screen = new FakeScreen();
    let captured = 0;
    const source = makeDataSource(async () => scanSummary());
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: {
        ...source,
        addCurrentAccount: async () => {
          captured += 1;
          return 'stored me@test.dev (keychain)';
        },
      },
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
      quotaPollMs: 60_000,
    });

    // Act — open the accounts tab and press n
    const done = session.run();
    await settle();
    screen.pressKey('2');
    screen.pressKey('n');
    await settle();
    const guide = screen.lastFrame().join('\n');

    // Assert — the login walkthrough shows BEFORE any capture happens
    expect(guide).toContain('/login');
    expect(guide).toContain('press n');
    expect(captured).toBe(0);

    // Act — confirm stores the current login
    screen.pressKey('y');
    await settle();

    // Assert
    expect(captured).toBe(1);
    expect(screen.lastFrame().join('\n')).toContain('stored me@test.dev');
    session.stop();
    await done;
  });
});

describe('account action routing', () => {
  function vaultEntry(agent: string, accountId: string) {
    return {
      agent,
      accountId,
      email: null,
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
      backend: 'file' as const,
      refreshDeadAtUtc: null,
    };
  }

  test('switch and remove reach the data source with the row agent, not just the id', async () => {
    // Arrange — two agents legitimately share one account id; the row's
    // agent is what keeps the action from landing on the wrong login
    const screen = new FakeScreen();
    const switches: [string, string][] = [];
    const removals: [string, string][] = [];
    const source = makeDataSource(async () => scanSummary());
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: {
        ...source,
        loadAccounts: async () => ({
          snapshots: [],
          vault: [vaultEntry('claude-code', 'uuid-x'), vaultEntry('codex', 'uuid-x')],
          discovered: [],
          activeAccountId: null,
        }),
        switchToAccount: async (agent: string, accountId: string) => {
          switches.push([agent, accountId]);
          return 'switched';
        },
        removeAccount: async (agent: string, accountId: string) => {
          removals.push([agent, accountId]);
          return 'removed';
        },
      },
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
      quotaPollMs: 60_000,
    });

    // Act — select the codex row (second) and switch, then remove
    const done = session.run();
    await settle();
    screen.pressKey('2');
    await settle();
    screen.pressKey('j');
    screen.pressKey('s');
    await settle();
    screen.pressKey('y');
    await settle();
    // the action result notice must be dismissed before keys route back
    screen.pressKey('escape');
    await settle();
    screen.pressKey('j');
    screen.pressKey('x');
    await settle();
    screen.pressKey('y');
    await settle();
    session.stop();
    await done;

    // Assert — both actions carried (agent, accountId), codex included
    expect(switches).toEqual([['codex', 'uuid-x']]);
    expect(removals).toEqual([['codex', 'uuid-x']]);
  });
});

describe('ledger compaction', () => {
  test('V on the Doctor tab confirms, compacts, and reports sizes', async () => {
    // Arrange
    const screen = new FakeScreen();
    let compactions = 0;
    const source = makeDataSource(async () => scanSummary());
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource: {
        ...source,
        compactLedger: async () => {
          compactions += 1;
          return 'compacted 231.0 MB → 180.0 MB (reclaimed 51.0 MB)';
        },
      },
      chartMode: 'block',
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: preferences(),
    });

    // Act — the confirm gate comes first: VACUUM blocks collection
    const done = session.run();
    await settle();
    screen.pressKey('6');
    screen.pressKey('V');
    await settle();
    const beforeConfirm = compactions;
    screen.pressKey('y');
    await settle();
    const frame = screen.lastFrame().join('\n');
    session.stop();
    await done;

    // Assert
    expect(beforeConfirm).toBe(0);
    expect(compactions).toBe(1);
    expect(frame).toContain('reclaimed 51.0 MB');
  });
});

describe('overview day selection', () => {
  function dayBucket(key: string, inputTokens: number) {
    return {
      key,
      rowCount: 5,
      promptCount: 5,
      tokens: { inputTokens, outputTokens: 100, cacheWrite: 0, cacheRead: 50, reasoningTokens: 7 },
      spendCost: { basis: 'spend' as const, usd: 1.25, pricedSubtotalUsd: 1.25, pricedRows: 5, unpricedRows: 0, warnings: [] },
      quotaCost: { basis: 'quota' as const, usd: 4.5, pricedSubtotalUsd: 4.5, pricedRows: 5, unpricedRows: 0, warnings: [] },
      unpricedRows: 0,
      unknownRows: 0,
      unknownUsd: 0,
      unpricedModels: [],
    };
  }

  function dayDataSource() {
    const dayReports: string[] = [];
    const source = makeDataSource(async () => scanSummary());
    const dataSource: TuiDataSource = {
      ...source,
      async loadReport(groupBy: ReportGroupBy): Promise<ReportSummary> {
        const summary = emptyReport(groupBy);
        if (groupBy !== 'day') {
          return summary;
        }
        return {
          ...summary,
          buckets: [dayBucket('2026-08-01', 1000), dayBucket('2026-08-02', 5000)],
          totals: { ...summary.totals, rowCount: 10 },
        };
      },
      async loadDayReport(date: string) {
        dayReports.push(date);
        return {
          agents: {
            ...emptyReport('agent'),
            buckets: [dayBucket('claude-code', 900)],
          },
          modelsByAgent: {
            'claude-code': {
              ...emptyReport('model'),
              buckets: [dayBucket('claude-fable-5', 900)],
            },
          },
        };
      },
    };
    return { dataSource, dayReports };
  }

  async function daySession() {
    const screen = new FakeScreen(100, 30);
    const { dataSource, dayReports } = dayDataSource();
    const saved: Record<string, unknown>[] = [];
    const session = await createTuiSession({
      createScreen: async () => screen,
      dataSource,
      chartMode: null,
      themeName: null,
      refreshSeconds: null,
      monoForced: true,
      firstRun: false,
      preferences: {
        load: () => ({
          theme: null,
          autoRefreshSeconds: undefined,
          paintBackground: undefined,
          chartStyle: null,
        }),
        save: (patch) => {
          saved.push({ ...patch });
          return null;
        },
      },
    });
    return { screen, session, dayReports, saved };
  }

  test('down selects the newest day, arrows walk, Esc returns', async () => {
    // Arrange
    const { screen, session, dayReports } = await daySession();
    const done = session.run();
    await settle();

    // Act — enter selection on the newest day
    screen.pressKey('down');
    await settle();
    const selectedFrame = screen.lastFrame().join('\n');

    // walk to the previous day
    screen.pressKey('left');
    await settle();
    const walkedFrame = screen.lastFrame().join('\n');

    // and leave
    screen.pressKey('escape');
    await settle();
    const closedFrame = screen.lastFrame().join('\n');
    session.stop();
    await done;

    // Assert
    expect(selectedFrame).toContain('▾ 2026-08-02');
    expect(selectedFrame).toContain('claude-code · 5 prompts');
    expect(selectedFrame).toContain('claude-fable-5');
    expect(walkedFrame).toContain('▾ 2026-08-01');
    expect(closedFrame).toContain('QUOTA COST (list-price)');
    expect(dayReports).toEqual(['2026-08-02', '2026-08-01']);
  });

  test('a chart click selects the day under the pointer', async () => {
    // Arrange
    const { screen, session, dayReports } = await daySession();
    const done = session.run();
    await settle();

    // Act — body row 2 is the first plot row (blank + title above);
    // the shell adds 2 rows above the body, so screen y = 4. Column 7
    // is the first plot cell after the value axis.
    screen.click(7, 4);
    await settle();
    const frame = screen.lastFrame().join('\n');
    session.stop();
    await done;

    // Assert
    expect(frame).toContain('▾ 2026-08-01');
    expect(dayReports).toEqual(['2026-08-01']);
  });

  test('g picks a chart style, remembers it, and re-renders', async () => {
    // Arrange
    const { screen, session, saved } = await daySession();
    const done = session.run();
    await settle();

    // Act — open the picker and choose the heatmap (last option)
    screen.pressKey('g');
    await settle();
    const pickerFrame = screen.lastFrame().join('\n');
    screen.pressKey('down');
    screen.pressKey('down');
    screen.pressKey('return');
    await settle();
    const heatmapFrame = screen.lastFrame().join('\n');
    session.stop();
    await done;

    // Assert
    expect(pickerFrame).toContain('Chart style');
    expect(heatmapFrame).toContain('(calendar)');
    expect(saved).toContainEqual({ chartStyle: 'heatmap' });
  });
});
