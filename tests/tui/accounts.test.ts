import { describe, expect, test } from 'bun:test';

import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { buildQuotaBar, describeReset, severityMarker } from '@llmtally/tui/components/quota-bar.ts';
import { createInitialState, withActiveTab, withTabResource } from '@llmtally/tui/state.ts';
import { isSwitchable, toAccountsTabViewModel } from '@llmtally/tui/view-model/accounts.ts';
import type { AccountRowViewModel, AccountsInput } from '@llmtally/tui/view-model/accounts.ts';
import { accountsTabView } from '@llmtally/tui/views/accounts.ts';
import { viewText } from './helpers.ts';
import { lineText } from '@llmtally/tui/rich-text.ts';
import { frameText } from '@llmtally/tui/rich-text.ts';
import { DEFAULT_TAB_VIEWS, renderShell } from '@llmtally/tui/views/shell.ts';

const NOW = 1_800_000_000;

function inputFor(snapshots: readonly QuotaSnapshot[], overrides: Partial<AccountsInput> = {}): AccountsInput {
  return { snapshots, vault: [], discovered: [], activeAccountId: null, ...overrides };
}

function snapshotFixture(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    agent: 'claude-code',
    accountId: null,
    account: null,
    plan: 'team',
    source: 'vendor_api',
    observedAtUtc: NOW,
    windows: [
      { id: 'five_hour', usedPercent: 84, resetsAtUtc: NOW + 15_060 },
      { id: 'seven_day', usedPercent: 24, resetsAtUtc: NOW + 90_000 },
    ],
    warnings: [],
    failure: null,
    rateLimited: false,
    retryAfterSeconds: null,
    ...overrides,
  };
}

describe('toAccountsTabViewModel', () => {
  test('maps windows, clamps fill, keeps raw percent above 100', () => {
    // Arrange
    const snapshot = snapshotFixture({
      windows: [{ id: 'w', usedPercent: 130, resetsAtUtc: null }],
    });

    // Act
    const model = toAccountsTabViewModel(inputFor([snapshot]));

    // Assert
    expect(model.rows[0]?.quota?.bars[0]).toMatchObject({ usedPercent: 130, fillRatio: 1 });
  });

  test('sanitizes provider strings carrying control characters', () => {
    // Arrange - real ESC/BEL bytes built at runtime
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const hostile = snapshotFixture({
      agent: 'codex' + ESC + '[2J',
      warnings: ['stale' + BEL + ' reading'],
    });

    // Act
    const model = toAccountsTabViewModel(inputFor([hostile]));

    // Assert
    expect(model.rows[0]?.quota?.agent).toBe('codex[2J');
    expect(model.rows[0]?.quota?.warnings[0]).toBe('stale reading');
  });

  test('drops non-finite percents but keeps the provider', () => {
    // Arrange
    const broken = snapshotFixture({
      windows: [{ id: 'w', usedPercent: Number.NaN, resetsAtUtc: null }],
    });

    // Act
    const model = toAccountsTabViewModel(inputFor([broken]));

    // Assert
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.quota?.bars).toHaveLength(0);
  });
});

describe('quota-bar components', () => {
  test('severity markers switch at 80 and 95 percent', () => {
    // Act & Assert
    expect(severityMarker(50).trim()).toBe('');
    expect(severityMarker(84)).toBe('[!] ');
    expect(severityMarker(97)).toBe('[!!]');
  });

  test('gauge geometry stays inside brackets at extremes', () => {
    // Act
    const empty = lineText(buildQuotaBar({ id: 'w', usedPercent: 0, fillRatio: 0, resetsAtUtc: null }, 10));
    const full = lineText(buildQuotaBar({ id: 'w', usedPercent: 100, fillRatio: 1, resetsAtUtc: null }, 10));

    // Assert
    expect(empty).toBe('[··········]  0.0%');
    expect(full).toBe('[■■■■■■■■■■]100.0%');
  });

  test('describeReset formats hours/minutes and handles the past', () => {
    // Act & Assert
    expect(describeReset(NOW + 15_060, NOW)).toBe('resets 4h 11m');
    expect(describeReset(NOW - 5, NOW)).toBe('resets soon');
    expect(describeReset(null, NOW)).toBe('');
  });
});

describe('accountsTabView', () => {
  function stateWith(model: ReturnType<typeof toAccountsTabViewModel>) {
    return withTabResource(withActiveTab(createInitialState(), 'accounts'), 'accounts', {
      phase: 'ready',
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });
  }

  test('renders both providers independently inside the shell', () => {
    // Arrange
    const model = toAccountsTabViewModel(inputFor([
      snapshotFixture(),
      snapshotFixture({
        agent: 'codex',
        plan: 'prolite',
        source: 'source_log',
        observedAtUtc: NOW - 120,
        windows: [{ id: 'primary (10080m)', usedPercent: 97, resetsAtUtc: NOW + 500_000 }],
        warnings: ['codex reading is 2 minutes old (from local logs, not live)'],
      }),
    ]));
    const state = stateWith(model);

    // Act
    const frame = frameText(
      renderShell(state, 100, 30, NOW, {
        ...DEFAULT_TAB_VIEWS,
        accounts: accountsTabView,
      }),
    );
    const text = frame.join('\n');

    // Assert
    expect(text).toContain('claude-code · (current login) (team) — live');
    expect(text).toContain('codex · (current login) (prolite) — from local logs, as of 2m ago');
    expect(text).toContain('[!] ');
    expect(text).toContain('[!!]');
    expect(text).toContain('resets 4h 11m');
    expect(text).toContain('! codex reading is 2 minutes old');
    for (const line of frame) {
      expect(Bun.stringWidth(line)).toBe(100);
    }
  });

  test('shows the account label and cached-source description', () => {
    // Arrange
    const model = toAccountsTabViewModel(inputFor([
      snapshotFixture({
        agent: 'antigravity',
        account: 'a@test.dev',
        plan: null,
        source: 'third_party_cache',
        observedAtUtc: NOW - 7200,
        windows: [{ id: 'Gemini 3.1 Pro (High)', usedPercent: 75, resetsAtUtc: null }],
      }),
    ]));

    // Act
    const text = viewText(accountsTabView(stateWith(model), 100, 24, NOW)).join('\n');

    // Assert
    expect(text).toContain('antigravity · a@test.dev — cached, as of 2h ago');
  });

  test('shows loading and error states without data', () => {
    // Arrange
    const base = withActiveTab(createInitialState(), 'accounts');
    const loading = withTabResource(base, 'accounts', {
      phase: 'loading',
      data: null,
      error: null,
      updatedAtUtc: null,
      invalidated: false,
    });
    const failed = withTabResource(base, 'accounts', {
      phase: 'error',
      data: null,
      error: 'network down',
      updatedAtUtc: null,
      invalidated: false,
    });

    // Act & Assert
    expect(viewText(accountsTabView(loading, 80, 20, NOW)).join('')).toContain('loading accounts…');
    expect(viewText(accountsTabView(failed, 80, 20, NOW)).join('')).toContain('accounts unavailable: network down');
  });

  test('keeps last data and flags the failure on refresh error', () => {
    // Arrange
    const model = toAccountsTabViewModel(inputFor([snapshotFixture()]));
    const state = withTabResource(withActiveTab(createInitialState(), 'accounts'), 'accounts', {
      phase: 'error',
      data: model,
      error: 'timeout',
      updatedAtUtc: NOW - 300,
      invalidated: false,
    });

    // Act
    const text = viewText(accountsTabView(state, 100, 24, NOW)).join('\n');

    // Assert
    expect(text).toContain('claude-code · (current login) (team)');
    expect(text).toContain('refresh failed: timeout (showing last data)');
  });
});

describe('account matching (review regression)', () => {
  function vaultEntry(accountId: string, email: string) {
    return {
      agent: 'claude-code',
      accountId,
      email,
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
      backend: 'keychain' as const,
      refreshDeadAtUtc: null,
    };
  }

  test('one stored account binds to its quota row', () => {
    // Act
    const model = toAccountsTabViewModel(
      inputFor([snapshotFixture({ account: 'me@test.dev' })], {
        vault: [vaultEntry('uuid-1', 'me@test.dev')],
        activeAccountId: 'uuid-1',
      }),
    );

    // Assert
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ accountId: 'uuid-1', isActive: true });
  });

  test('two accounts sharing an address never bind to the wrong one', () => {
    // Arrange — personal and organization logins with the same address
    const vault = [vaultEntry('uuid-personal', 'me@test.dev'), vaultEntry('uuid-org', 'me@test.dev')];

    // Act — no active account to disambiguate with
    const ambiguous = toAccountsTabViewModel(
      inputFor([snapshotFixture({ account: 'me@test.dev' })], { vault }),
    );
    // ...and with one, the active account wins
    const resolved = toAccountsTabViewModel(
      inputFor([snapshotFixture({ account: 'me@test.dev' })], {
        vault,
        activeAccountId: 'uuid-org',
      }),
    );

    // Assert — an unresolvable row offers no switch/remove target
    expect(ambiguous.rows[0]?.accountId).toBeNull();
    expect(ambiguous.rows[0]?.note).toContain('share this address');
    expect(resolved.rows[0]?.accountId).toBe('uuid-org');
  });

  test('stored accounts with no quota reading still get a row', () => {
    // Act
    const model = toAccountsTabViewModel(
      inputFor([], { vault: [vaultEntry('uuid-1', 'stored@test.dev')] }),
    );

    // Assert
    expect(model.rows[0]).toMatchObject({ accountId: 'uuid-1', label: 'stored@test.dev' });
    expect(model.rows[0]?.note).toContain('stored');
  });

  test('the live login is active even before it was ever stored in the vault', () => {
    // Arrange — snapshot carries the stable id; the vault knows nothing
    const model = toAccountsTabViewModel(
      inputFor([snapshotFixture({ accountId: 'uuid-live', account: 'live@test.dev' })], {
        vault: [],
        activeAccountId: 'uuid-live',
      }),
    );

    // Assert
    expect(model.rows[0]?.isActive).toBe(true);
    expect(model.rows[0]?.accountId).toBeNull();
  });

  test('a stable account id binds past an ambiguous shared email', () => {
    // Arrange — two entries share the address, but the snapshot names its id
    const vault = [vaultEntry('uuid-personal', 'me@test.dev'), vaultEntry('uuid-org', 'me@test.dev')];

    // Act
    const model = toAccountsTabViewModel(
      inputFor([snapshotFixture({ accountId: 'uuid-org', account: 'me@test.dev' })], { vault }),
    );

    // Assert — no ambiguity note; the id decided
    expect(model.rows[0]?.accountId).toBe('uuid-org');
    expect(model.rows[0]?.note).toBeNull();
  });

  test('a stale registry marker cannot mark the wrong account active', () => {
    // Arrange — data-source passes the live identity as activeAccountId,
    // so a row whose snapshot names a different id must not be active
    const model = toAccountsTabViewModel(
      inputFor(
        [snapshotFixture({ accountId: 'uuid-stored', account: 'stored@test.dev' })],
        { vault: [vaultEntry('uuid-stored', 'stored@test.dev')], activeAccountId: 'uuid-live' },
      ),
    );

    // Assert
    expect(model.rows[0]?.isActive).toBe(false);
  });
});

describe('dead-token warning', () => {
  function deadEntry(accountId: string, email: string) {
    return { ...vaultEntry(accountId, email), refreshDeadAtUtc: NOW - 3600 };
  }

  function vaultEntry(accountId: string, email: string) {
    return {
      agent: 'claude-code',
      accountId,
      email,
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
      backend: 'keychain' as const,
      refreshDeadAtUtc: null,
    };
  }

  function renderRows(input: AccountsInput): string {
    const state = withTabResource(withActiveTab(createInitialState(), 'accounts'), 'accounts', {
      phase: 'ready' as const,
      data: toAccountsTabViewModel(input),
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });
    return viewText(accountsTabView(state, 100, 40, NOW)).join('\n');
  }

  test('a quarantined vault-only row warns at a glance', () => {
    // Act
    const text = renderRows(inputFor([], { vault: [deadEntry('uuid-dead', 'dead@test.dev')] }));

    // Assert — visible in the title marks AND as a body warning
    expect(text).toContain('re-login needed');
    expect(text).toContain('/login as this account once');
  });

  test('a quarantined row with a quota reading still warns', () => {
    // Arrange — stale stored numbers exist, but the lineage is dead
    const snapshot = snapshotFixture({
      accountId: 'uuid-dead',
      account: 'dead@test.dev',
      source: 'stored_history',
    });

    // Act
    const text = renderRows(
      inputFor([snapshot], { vault: [deadEntry('uuid-dead', 'dead@test.dev')] }),
    );

    // Assert
    expect(text).toContain('re-login needed');
  });

  test('the switch hint is disabled for a dead row', () => {
    // Act — cursor sits on the only (dead) row
    const model = toAccountsTabViewModel(
      inputFor([], { vault: [deadEntry('uuid-dead', 'dead@test.dev')] }),
    );

    // Assert — the view model exposes the flag the action line dims on
    expect(model.rows[0]?.refreshDead).toBe(true);
  });

  test('healthy rows carry no warning', () => {
    // Act
    const text = renderRows(inputFor([], { vault: [vaultEntry('uuid-ok', 'ok@test.dev')] }));

    // Assert
    expect(text).not.toContain('re-login needed');
  });
});

describe('accounts view source labels', () => {
  function stateWith(model: ReturnType<typeof toAccountsTabViewModel>) {
    return withTabResource(withActiveTab(createInitialState(), 'accounts'), 'accounts', {
      phase: 'ready' as const,
      data: model,
      error: null,
      updatedAtUtc: NOW,
      invalidated: false,
    });
  }

  test('a rate-limited reading serving cached numbers says stale, never live', () => {
    // Arrange
    const stale = snapshotFixture({
      account: 'me@test.dev',
      observedAtUtc: NOW - 600,
      failure: { kind: 'rate_limited', failedAtUtc: NOW, retryAtUtc: NOW + 360 },
      rateLimited: true,
    });
    const model = toAccountsTabViewModel(inputFor([stale]));

    // Act
    const text = viewText(accountsTabView(stateWith(model), 100, 40, NOW)).join('\n');

    // Assert
    expect(text).toContain('stale, as of 10m ago');
    expect(text).not.toContain('— live');
  });

  test('a healthy vendor reading still says live', () => {
    // Arrange
    const model = toAccountsTabViewModel(inputFor([snapshotFixture({ account: 'me@test.dev' })]));

    // Act & Assert
    expect(viewText(accountsTabView(stateWith(model), 100, 40, NOW)).join('\n')).toContain('live');
  });
});

describe('multi-agent accounts', () => {
  function codexVaultEntry(accountId: string, email: string) {
    return {
      agent: 'codex',
      accountId,
      email,
      organizationUuid: null,
      organizationName: null,
      alias: null,
      addedAtUtc: NOW,
      backend: 'keychain' as const,
      refreshDeadAtUtc: null,
    };
  }

  test('a stored codex account is switchable', () => {
    // Act
    const model = toAccountsTabViewModel(
      inputFor([], { vault: [codexVaultEntry('codex-2', 'two@test.dev')] }),
    );

    // Assert
    expect(model.switchableAgents).toContain('codex');
    expect(model.rows[0]?.accountId).toBe('codex-2');
  });

  test('the active codex account comes from activeByAgent, not the claude marker', () => {
    // Arrange — codex live snapshot carries its account id
    const snapshot = snapshotFixture({
      agent: 'codex',
      accountId: 'codex-1',
      account: 'one@test.dev',
    });

    // Act
    const model = toAccountsTabViewModel(
      inputFor([snapshot], {
        vault: [codexVaultEntry('codex-1', 'one@test.dev'), codexVaultEntry('codex-2', 'two@test.dev')],
        activeAccountId: 'claude-uuid-unrelated',
        activeByAgent: { codex: 'codex-1' },
      }),
    );

    // Assert — the live codex row is active; the stored alternate is not
    const live = model.rows.find((row) => row.accountId === 'codex-1');
    const stored = model.rows.find((row) => row.accountId === 'codex-2');
    expect(live?.isActive).toBe(true);
    expect(stored?.isActive).toBe(false);
  });

  test('the active antigravity account is marked from activeByAgent', () => {
    // Arrange — read-only agent: rows come from snapshots only
    const active = snapshotFixture({
      agent: 'antigravity',
      accountId: 'a@test.dev',
      account: 'a@test.dev',
    });
    const other = snapshotFixture({
      agent: 'antigravity',
      accountId: 'b@test.dev',
      account: 'b@test.dev',
    });

    // Act
    const model = toAccountsTabViewModel(
      inputFor([active, other], { activeByAgent: { antigravity: 'a@test.dev' } }),
    );

    // Assert — active marked, and antigravity is NOT switchable
    expect(model.rows[0]?.isActive).toBe(true);
    expect(model.rows[1]?.isActive).toBe(false);
    expect(model.switchableAgents).not.toContain('antigravity');
  });
});

describe('quota window normalization and ordering', () => {
  test('provider-specific ids map onto the 5hours/7days/1month policy', () => {
    // Arrange — one snapshot carrying every naming convention we ingest
    const snapshot = snapshotFixture({
      windows: [
        { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
        { id: 'five_hour', usedPercent: 20, resetsAtUtc: null },
        { id: '7d Fable', usedPercent: 30, resetsAtUtc: null },
        { id: 'seven_day_opus', usedPercent: 40, resetsAtUtc: null },
      ],
    });

    // Act
    const bars = toAccountsTabViewModel(inputFor([snapshot])).rows[0]?.quota?.bars ?? [];

    // Assert — policy labels, model-scoped as 7days_<Model>
    expect(bars.map((bar) => bar.id)).toEqual([
      '5hours',
      '7days',
      '7days_Fable',
      '7days_Opus',
    ]);
  });

  test('opencode and cline window names map onto the same policy', () => {
    // Arrange — the adapters keep each vendor's own names; only the
    // display policy is shared, so the eye compares like with like
    const opencode = snapshotFixture({
      agent: 'opencode',
      accountId: 'cline-pass.opencode-go.3f2a9c',
      windows: [
        { id: 'monthly', usedPercent: 43, resetsAtUtc: null },
        { id: 'rolling', usedPercent: 1, resetsAtUtc: null },
        { id: 'weekly', usedPercent: 12, resetsAtUtc: null },
      ],
    });
    const cline = snapshotFixture({
      agent: 'cline',
      accountId: 'usr-01KYVB',
      windows: [
        { id: 'weekly', usedPercent: 4, resetsAtUtc: null },
        { id: 'five_hour', usedPercent: 0, resetsAtUtc: null },
        { id: 'monthly', usedPercent: 2, resetsAtUtc: null },
      ],
    });

    // Act
    const rows = toAccountsTabViewModel(inputFor([opencode, cline])).rows;

    // Assert — both land on the policy labels, in canonical order
    expect(rows[0]?.quota?.bars.map((bar) => bar.id)).toEqual(['5hours', '7days', '1month']);
    expect(rows[1]?.quota?.bars.map((bar) => bar.id)).toEqual(['5hours', '7days', '1month']);
  });

  test('a cline reading stays its own row rather than merging into opencode', () => {
    // Arrange — one credential file, two subscriptions
    const opencode = snapshotFixture({
      agent: 'opencode',
      accountId: 'cline-pass.opencode-go.3f2a9c',
      account: 'cline-pass.opencode-go.3f2a9c',
      plan: 'Go',
      windows: [{ id: 'monthly', usedPercent: 43, resetsAtUtc: null }],
    });
    const cline = snapshotFixture({
      agent: 'cline',
      accountId: 'usr-01KYVB',
      account: 'me@test.dev',
      plan: 'Cline Pass (Monthly)',
      windows: [{ id: 'monthly', usedPercent: 2, resetsAtUtc: null }],
    });

    // Act
    const rows = toAccountsTabViewModel(inputFor([opencode, cline])).rows;

    // Assert — independent rows keep independent numbers and captions
    expect(rows).toHaveLength(2);
    expect(rows[0]?.agent).toBe('opencode');
    expect(rows[1]?.agent).toBe('cline');
    expect(rows[1]?.label).toBe('me@test.dev');
    expect(rows[1]?.quota?.bars[0]?.usedPercent).toBe(2);
    // cline logins are not ours to swap
    expect(isSwitchable(rows[1] as AccountRowViewModel)).toBe(false);
  });

  test('codex minute-suffixed windows map by duration', () => {
    // Arrange — 300m = 5h, 10080m = 7d, 43200m = 30d
    const snapshot = snapshotFixture({
      agent: 'codex',
      windows: [
        { id: 'GPT-5.3-Codex-Spark (10080m)', usedPercent: 5, resetsAtUtc: null },
        { id: 'primary (43200m)', usedPercent: 15, resetsAtUtc: null },
        { id: 'primary (10080m)', usedPercent: 25, resetsAtUtc: null },
        { id: 'primary (300m)', usedPercent: 35, resetsAtUtc: null },
      ],
    });

    // Act
    const bars = toAccountsTabViewModel(inputFor([snapshot])).rows[0]?.quota?.bars ?? [];

    // Assert — 5hours < 7days (common before model) < 1month
    expect(bars.map((bar) => bar.id)).toEqual([
      '5hours',
      '7days',
      '7days_GPT-5.3-Codex-Spark',
      '1month',
    ]);
  });

  test('the order is canonical however the source delivered the windows', () => {
    // Arrange — stored_history returns windows alphabetically; live does not.
    // Both must render identically or the card jumps between refreshes.
    const alphabetical = snapshotFixture({
      source: 'stored_history',
      windows: [
        { id: '7d Fable', usedPercent: 30, resetsAtUtc: null },
        { id: 'five_hour', usedPercent: 20, resetsAtUtc: null },
        { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
      ],
    });
    const providerOrder = snapshotFixture({
      windows: [
        { id: 'five_hour', usedPercent: 20, resetsAtUtc: null },
        { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
        { id: '7d Fable', usedPercent: 30, resetsAtUtc: null },
      ],
    });

    // Act
    const fromStored = toAccountsTabViewModel(inputFor([alphabetical])).rows[0]?.quota?.bars ?? [];
    const fromLive = toAccountsTabViewModel(inputFor([providerOrder])).rows[0]?.quota?.bars ?? [];

    // Assert
    expect(fromStored.map((bar) => bar.id)).toEqual(fromLive.map((bar) => bar.id));
    expect(fromLive.map((bar) => bar.id)).toEqual(['5hours', '7days', '7days_Fable']);
  });

  test('unknown window shapes keep their label and sort last, alphabetically', () => {
    // Arrange — antigravity model labels carry no window duration
    const snapshot = snapshotFixture({
      agent: 'antigravity',
      windows: [
        { id: 'Gemini 3.5 Flash (High)', usedPercent: 5, resetsAtUtc: null },
        { id: 'Gemini 3.1 Pro (High)', usedPercent: 10, resetsAtUtc: null },
      ],
    });
    const withKnown = snapshotFixture({
      windows: [
        { id: 'Gemini 3.1 Pro (High)', usedPercent: 10, resetsAtUtc: null },
        { id: 'five_hour', usedPercent: 20, resetsAtUtc: null },
      ],
    });

    // Act & Assert
    expect(
      (toAccountsTabViewModel(inputFor([snapshot])).rows[0]?.quota?.bars ?? []).map((bar) => bar.id),
    ).toEqual(['Gemini 3.1 Pro (High)', 'Gemini 3.5 Flash (High)']);
    expect(
      (toAccountsTabViewModel(inputFor([withKnown])).rows[0]?.quota?.bars ?? []).map((bar) => bar.id),
    ).toEqual(['5hours', 'Gemini 3.1 Pro (High)']);
  });

  test('the monthly extra-usage axis sorts with 1month but keeps its spend label', () => {
    // Arrange
    const snapshot = snapshotFixture({
      windows: [
        { id: 'extra usage $13/$100', usedPercent: 12.5, resetsAtUtc: null },
        { id: 'five_hour', usedPercent: 20, resetsAtUtc: null },
        { id: 'seven_day', usedPercent: 10, resetsAtUtc: null },
      ],
    });

    // Act
    const bars = toAccountsTabViewModel(inputFor([snapshot])).rows[0]?.quota?.bars ?? [];

    // Assert — spend detail survives; position follows the monthly rank
    expect(bars.map((bar) => bar.id)).toEqual(['5hours', '7days', 'extra usage $13/$100']);
  });
});

describe('opencode accounts', () => {
  function opencodeVaultEntry(accountId: string) {
    return {
      agent: 'opencode',
      accountId,
      email: null,
      organizationUuid: null,
      organizationName: 'opencode-go',
      alias: null,
      addedAtUtc: NOW,
      backend: 'keychain' as const,
      refreshDeadAtUtc: null,
    };
  }

  test('a stored opencode credential set is switchable with an active marker', () => {
    // Act
    const model = toAccountsTabViewModel(
      inputFor([], {
        vault: [
          opencodeVaultEntry('opencode-go.aaaaaa'),
          opencodeVaultEntry('opencode-go.bbbbbb'),
        ],
        activeByAgent: { opencode: 'opencode-go.aaaaaa' },
      }),
    );

    // Assert
    expect(model.switchableAgents).toContain('opencode');
    const active = model.rows.find((row) => row.accountId === 'opencode-go.aaaaaa');
    const stored = model.rows.find((row) => row.accountId === 'opencode-go.bbbbbb');
    expect(active?.isActive).toBe(true);
    expect(stored?.isActive).toBe(false);
  });
});
