import { describe, expect, test } from 'bun:test';

import type { QuotaSnapshot } from '@llmtally/core/quota/providers.ts';
import { buildQuotaBar, describeReset, severityMarker } from '@llmtally/tui/components/quota-bar.ts';
import { createInitialState, withActiveTab, withTabResource } from '@llmtally/tui/state.ts';
import { toAccountsTabViewModel } from '@llmtally/tui/view-model/accounts.ts';
import type { AccountsInput } from '@llmtally/tui/view-model/accounts.ts';
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
    account: null,
    plan: 'team',
    source: 'vendor_api',
    observedAtUtc: NOW,
    windows: [
      { id: 'five_hour', usedPercent: 84, resetsAtUtc: NOW + 15_060 },
      { id: 'seven_day', usedPercent: 24, resetsAtUtc: NOW + 90_000 },
    ],
    warnings: [],
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
});
