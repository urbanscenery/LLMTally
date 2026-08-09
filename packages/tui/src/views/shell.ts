import { buildFooterLine } from '../components/footer.ts';
import { renderHelpOverlay } from '../components/help-overlay.ts';
import {
  renderConfirmOverlay,
  renderNoticeOverlay,
  renderInputOverlay,
  renderPickerOverlay,
} from '../components/overlay-view.ts';
import { fitRichLine, plainLine } from '../rich-text.ts';
import type { RichFrame, RichLine, StyledSpan } from '../rich-text.ts';
import type { TuiState } from '../state.ts';
import { displayWidth, fitLine } from '../text.ts';
import { TUI_TABS } from '../types.ts';
import type { TuiTab } from '../types.ts';

/** Views may return plain strings or styled lines; both are normalized. */
export type TabViewLine = string | RichLine;

export type TabView = (
  state: TuiState,
  width: number,
  height: number,
  nowUtc: number,
) => readonly TabViewLine[];

/** An open overlay replaces the tab body; it never renders behind it. */
function renderBody(
  state: TuiState,
  width: number,
  height: number,
  nowUtc: number,
  views: Record<TuiTab, TabView>,
): readonly TabViewLine[] {
  const overlay = state.overlay;
  if (overlay === null) {
    return views[state.activeTab](state, width, height, nowUtc);
  }
  switch (overlay.kind) {
    case 'help':
      return renderHelpOverlay(width, height);
    case 'picker':
      return renderPickerOverlay(overlay, width, height);
    case 'confirm':
      return renderConfirmOverlay(overlay, width, height);
    case 'input':
      return renderInputOverlay(overlay, width, height);
    default:
      return renderNoticeOverlay(overlay, width, height);
  }
}

function toRichLine(line: TabViewLine): RichLine {
  return typeof line === 'string' ? plainLine(line) : line;
}

const TAB_LABELS: Record<TuiTab, string> = {
  overview: 'Overview',
  accounts: 'Accounts',
  agents: 'Agents',
  models: 'Models',
  search: 'Search',
  doctor: 'Doctor',
};

function placeholderView(label: string): TabView {
  return (_state, width) => [fitLine(`  ${label} — coming soon`, width)];
}

/** Later phases replace these entries with real tab renderers. */
export const DEFAULT_TAB_VIEWS: Record<TuiTab, TabView> = {
  overview: placeholderView('Overview'),
  accounts: placeholderView('Accounts'),
  agents: placeholderView('Agents'),
  models: placeholderView('Models'),
  search: placeholderView('Search'),
  doctor: placeholderView('Doctor'),
};

const BRAND = ' LLMTally';

/**
 * The tab bar and its hit map are built from the same segments, so a
 * click can never land on a different tab than the one it is over.
 */
export function tabBarSegments(activeTab: TuiTab): {
  readonly spans: RichLine;
  readonly hits: readonly { readonly tab: TuiTab; readonly start: number; readonly end: number }[];
} {
  const spans: StyledSpan[] = [{ text: BRAND, role: 'accent', attributes: { bold: true } }];
  const hits: { tab: TuiTab; start: number; end: number }[] = [];
  let column = displayWidth(BRAND);
  TUI_TABS.forEach((tab, index) => {
    const divider = ' │';
    const label = `${tab === activeTab ? '▸' : ' '}[${index + 1}] ${TAB_LABELS[tab]}`;
    spans.push({ text: divider });
    spans.push(
      tab === activeTab
        ? { text: label, role: 'selected', attributes: { bold: true } }
        : { text: label, role: 'muted' },
    );
    const start = column + displayWidth(divider);
    const end = start + displayWidth(label);
    hits.push({ tab, start, end });
    column = end;
  });
  return { spans, hits };
}

/** Tab whose label covers this column, or null between labels. */
export function tabAtColumn(activeTab: TuiTab, column: number): TuiTab | null {
  return tabBarSegments(activeTab).hits.find((hit) => column >= hit.start && column < hit.end)?.tab ?? null;
}

function buildTabBar(state: TuiState, width: number): RichLine {
  return fitRichLine(tabBarSegments(state.activeTab).spans, width);
}

/**
 * Composes the full frame: tab bar, separator, body, separator, footer.
 * Pure — the renderer adapter resolves roles and prints the frame.
 */
export function renderShell(
  state: TuiState,
  width: number,
  height: number,
  nowUtc: number,
  views: Record<TuiTab, TabView> = DEFAULT_TAB_VIEWS,
): RichFrame {
  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(6, height);
  const separator: RichLine = [{ text: '─'.repeat(safeWidth), role: 'border' }];
  const bodyHeight = safeHeight - 4;

  const bodySource = renderBody(state, safeWidth, bodyHeight, nowUtc, views);
  const body = bodySource
    .slice(0, bodyHeight)
    .map((line) => fitRichLine(toRichLine(line), safeWidth));
  while (body.length < bodyHeight) {
    body.push(plainLine(' '.repeat(safeWidth)));
  }

  return [
    buildTabBar(state, safeWidth),
    separator,
    ...body,
    separator,
    buildFooterLine(state, safeWidth, nowUtc),
  ];
}
