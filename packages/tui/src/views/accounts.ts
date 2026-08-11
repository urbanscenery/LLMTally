import { renderCard } from '../components/card.ts';
import { buildQuotaBar, describeReset, severityMarker } from '../components/quota-bar.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine, StyledSpan } from '../rich-text.ts';
import type { TuiState } from '../state.ts';
import { fitLine, padEndWidth, truncateToWidth, wrapToWidth } from '../text.ts';
import { isSwitchable } from '../view-model/accounts.ts';
import type { AccountRowViewModel, QuotaProviderViewModel } from '../view-model/accounts.ts';
import type { TabView, TabViewLine } from './shell.ts';

const WIDE_GAUGE = 24;
const NARROW_GAUGE = 12;
const NARROW_BREAKPOINT = 80;
const LABEL_WIDTH = 18;

function describeSource(provider: QuotaProviderViewModel, nowUtc: number): string {
  const age = Math.max(0, nowUtc - provider.observedAtUtc);
  const text = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
  if (provider.source === 'vendor_api') {
    if (provider.failure === null) {
      return 'live';
    }
    // a failed read serving cached numbers must never claim "live"
    return provider.bars.length > 0 ? `stale, as of ${text} ago` : 'no reading';
  }
  if (provider.source === 'third_party_cache') {
    return `cached, as of ${text} ago`;
  }
  if (provider.source === 'stored_history') {
    return `stored, as of ${text} ago`;
  }
  return `from local logs, as of ${text} ago`;
}

function markerRole(usedPercent: number): 'danger' | 'warning' | 'default' {
  if (usedPercent > 95) {
    return 'danger';
  }
  if (usedPercent > 80) {
    return 'warning';
  }
  return 'default';
}

/** Clamped here so a cursor left over from a longer list stays valid. */
export function clampCursor(cursor: number, rowCount: number): number {
  if (rowCount === 0) {
    return 0;
  }
  return Math.max(0, Math.min(cursor, rowCount - 1));
}

function rowTitle(row: AccountRowViewModel, selected: boolean, nowUtc: number): string {
  const marks = [
    row.isActive ? 'active' : null,
    // the loudest mark comes first: a dead login invalidates everything
    // else the row appears to offer
    row.refreshDead ? '⚠ re-login needed' : null,
    isSwitchable(row) && !row.refreshDead ? 'switchable' : null,
    row.quota === null ? row.note : describeSource(row.quota, nowUtc),
  ].filter((part): part is string => part !== null && part !== '');
  const plan = row.quota?.plan == null ? '' : ` (${row.quota.plan})`;
  return `${selected ? '▸ ' : '  '}${row.agent} · ${row.label}${plan} — ${marks.join(' · ')}`;
}

function quotaLines(
  provider: QuotaProviderViewModel,
  narrow: boolean,
  gauge: number,
  nowUtc: number,
): RichLine[] {
  const lines: RichLine[] = [];
  for (const bar of provider.bars) {
    const marker = severityMarker(bar.usedPercent);
    const reset = describeReset(bar.resetsAtUtc, nowUtc);
    const label = padEndWidth(truncateToWidth(bar.id, LABEL_WIDTH), LABEL_WIDTH);
    const gaugeLine = joinLine(
      `${label} `,
      span(marker, markerRole(bar.usedPercent)),
      ' ',
      buildQuotaBar(bar, gauge),
    );
    if (reset === '') {
      lines.push(gaugeLine);
    } else if (narrow) {
      // no room on the gauge line — reset gets its own indented line
      lines.push(gaugeLine, joinLine(span(`  ${reset}`, 'muted')));
    } else {
      lines.push(joinLine(gaugeLine, span(`  ${reset}`, 'muted')));
    }
  }
  for (const warning of provider.warnings) {
    lines.push(joinLine(span(`! ${warning}`, 'warning')));
  }
  return lines;
}

function rowLines(
  row: AccountRowViewModel,
  selected: boolean,
  width: number,
  nowUtc: number,
): TabViewLine[] {
  const narrow = width < NARROW_BREAKPOINT;
  const gauge = narrow ? NARROW_GAUGE : WIDE_GAUGE;
  const content: RichLine[] =
    row.quota === null
      ? [joinLine(span(row.note ?? 'no quota reading', 'muted'))]
      : quotaLines(row.quota, narrow, gauge, nowUtc);
  if (content.length === 0) {
    content.push(joinLine(span('no quota windows reported', 'muted')));
  }
  const cardWidth = Math.min(width - 2, narrow ? width - 2 : 78);
  if (row.refreshDead) {
    // recovery instructions must never be elided — wrap, don't truncate
    content.unshift(
      ...wrapToWidth(
        '⚠ stored refresh token is dead — run "claude", /login as this account once (llmtally auto-heals)',
        cardWidth - 4,
      ).map((line): RichLine => joinLine(span(line, 'danger'))),
    );
  }
  return [
    ...renderCard({
      title: rowTitle(row, selected, nowUtc),
      content,
      width: cardWidth,
      active: selected,
    }).map((line): TabViewLine => joinLine(' ', line)),
    '',
  ];
}

/** Hints are dimmed when the selected row does not support the action. */
function actionLine(row: AccountRowViewModel | undefined): RichLine {
  const parts: StyledSpan[] = [];
  const push = (keys: string, text: string, enabled: boolean): void => {
    parts.push(span(keys, enabled ? 'key' : 'dim'), span(`${text}   `, enabled ? 'muted' : 'dim'));
  };
  push('[n]', ' add login', true);
  push('[s]', ' switch', row !== undefined && isSwitchable(row) && !row.isActive && !row.refreshDead);
  push('[x]', ' remove', row !== undefined && row.accountId !== null);
  push('[↑↓]', ' select', true);
  return parts;
}

export const accountsTabView: TabView = (
  state: TuiState,
  width: number,
  _height: number,
  nowUtc: number,
): readonly TabViewLine[] => {
  const resource = state.accounts;
  const model = resource.data;
  if (model === null) {
    if (resource.phase === 'loading') {
      return [fitLine('  loading accounts…', width)];
    }
    if (resource.phase === 'error') {
      return [fitLine(`  accounts unavailable: ${resource.error ?? 'unknown error'}`, width)];
    }
    return [fitLine('  accounts not loaded yet', width)];
  }
  const cursor = clampCursor(state.accountsCursor, model.rows.length);
  const lines: TabViewLine[] = [joinLine(' ', ...actionLine(model.rows[cursor])), ''];
  model.rows.forEach((row, index) => {
    lines.push(...rowLines(row, index === cursor, width, nowUtc));
  });
  if (model.rows.length === 0) {
    lines.push(fitLine('  no accounts found — press n to store the current login', width));
    lines.push(
      joinLine(
        span(
          fitLine('  (log in inside Claude Code first: run "claude", then /login)', width),
          'muted',
        ),
      ),
    );
  }
  if (resource.phase === 'error') {
    lines.push(
      joinLine(
        span(
          fitLine(`  ! refresh failed: ${resource.error ?? 'unknown'} (showing last data)`, width),
          'danger',
        ),
      ),
    );
  }
  return lines;
};
