import { formatCompact } from '../format.ts';
import type { RichLine, ThemeRole } from '../rich-text.ts';
import type { BreakdownSortColumn, SortSpec } from '../state.ts';
import { displayWidth, padEndWidth, padStartWidth, truncateToWidth } from '../text.ts';
import { formatCostCell } from '../view-model/cost.ts';
import type { BreakdownRowViewModel, BreakdownTabViewModel } from '../view-model/breakdown.ts';

interface Column {
  readonly id: string;
  readonly header: string;
  readonly align: 'left' | 'right';
  readonly minWidth: number;
  render(row: BreakdownRowViewModel): string;
}

const KEY_MAX_WIDTH = 28;

const COLUMNS: readonly Column[] = [
  {
    id: 'key',
    header: 'Name',
    align: 'left',
    minWidth: 12,
    render: (row) => row.key,
  },
  {
    id: 'rows',
    header: 'Prompts',
    align: 'right',
    minWidth: 7,
    render: (row) => row.promptCount.toLocaleString('en-US'),
  },
  {
    id: 'in',
    header: 'In',
    align: 'right',
    minWidth: 7,
    render: (row) => formatCompact(row.tokens.inputTokens),
  },
  {
    id: 'out',
    header: 'Out',
    align: 'right',
    minWidth: 7,
    render: (row) => formatCompact(row.tokens.outputTokens),
  },
  {
    id: 'cacheR',
    header: 'CacheR',
    align: 'right',
    minWidth: 7,
    render: (row) => formatCompact(row.tokens.cacheRead),
  },
  {
    id: 'cacheW',
    header: 'CacheW',
    align: 'right',
    minWidth: 7,
    render: (row) => formatCompact(row.tokens.cacheWrite),
  },
  {
    id: 'reason',
    header: 'Reason',
    align: 'right',
    minWidth: 7,
    render: (row) => formatCompact(row.tokens.reasoningTokens),
  },
  {
    id: 'spend',
    header: 'Spend',
    align: 'right',
    minWidth: 10,
    render: (row) => formatCostCell(row.spendCost),
  },
  {
    id: 'quota',
    header: 'Quota',
    align: 'right',
    minWidth: 12,
    render: (row) => formatCostCell(row.quotaCost),
  },
  {
    id: 'unpriced',
    header: 'Unpriced',
    align: 'right',
    minWidth: 8,
    render: (row) => (row.unpricedRows === 0 ? '' : String(row.unpricedRows)),
  },
];

/** Lowest-value columns disappear first when the terminal narrows. */
const DROP_ORDER = ['unpriced', 'cacheW', 'reason', 'cacheR', 'spend', 'out'] as const;

function pickColumns(width: number, showSpend: boolean): Column[] {
  const dropped = new Set<string>();
  if (!showSpend) {
    // a ledger with no billed rows would render an all-“—” column and
    // resurrect the old two-cost confusion
    dropped.add('spend');
  }
  const fits = (): boolean => {
    const kept = COLUMNS.filter((column) => !dropped.has(column.id));
    const total = kept.reduce((acc, column) => acc + column.minWidth + 2, 0);
    return total <= width;
  };
  for (const id of DROP_ORDER) {
    if (fits()) {
      break;
    }
    dropped.add(id);
  }
  return COLUMNS.filter((column) => !dropped.has(column.id));
}

function renderCell(column: Column, text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return column.align === 'left' ? padEndWidth(truncated, width) : padStartWidth(truncated, width);
}

/**
 * Column carrying each sortable key (k9s-style indicator placement).
 * The cost sort ranks by each row's primary basis; its indicator sits
 * on the quota column because that one is always visible.
 */
const SORT_COLUMN_IDS: Readonly<Record<BreakdownSortColumn, string>> = {
  rows: 'rows',
  cost: 'quota',
  input: 'in',
};

export const SORT_LABELS: Readonly<Record<BreakdownSortColumn, string>> = {
  rows: 'Rows',
  cost: 'Cost',
  input: 'In',
};

/**
 * Pure table renderer shared by the Agents and Models tabs: header
 * (with the k9s-style sort arrow), rule, data rows (visibleRows cap),
 * and a totals row.
 */
export function renderBreakdownTable(
  model: BreakdownTabViewModel,
  width: number,
  visibleRows: number,
  sort?: SortSpec,
  /** Highlighted row; -1 (the default) marks none. */
  cursor = -1,
): RichLine[] {
  const showSpend =
    model.totals.spendCost.pricedRows > 0 || model.totals.spendCost.unpricedRows > 0;
  const columns = pickColumns(width, showSpend);
  const sortedColumnId = sort === undefined ? null : SORT_COLUMN_IDS[sort.column];
  const arrow = sort?.direction === 'asc' ? '↑' : '↓';
  const headerText = (column: Column): string =>
    column.id === sortedColumnId ? `${column.header}${arrow}` : column.header;

  const widths = columns.map((column) => {
    const contentMax = Math.max(
      displayWidth(headerText(column)),
      ...model.rows.map((row) => displayWidth(column.render(row))),
      displayWidth(column.render(model.totals)),
    );
    const target = Math.max(column.minWidth, contentMax);
    return column.id === 'key' ? Math.min(KEY_MAX_WIDTH, target) : target;
  });
  // shrink the key column if the content-sized total still overflows
  const totalWidth = widths.reduce((acc, w) => acc + w + 2, -1);
  if (totalWidth > width) {
    const keyIndex = columns.findIndex((column) => column.id === 'key');
    if (keyIndex >= 0) {
      widths[keyIndex] = Math.max(8, (widths[keyIndex] ?? 8) - (totalWidth - width));
    }
  }

  // per-column semantic roles so cost cells keep their identity
  const CELL_ROLES: Readonly<Record<string, ThemeRole>> = {
    spend: 'spendCost',
    usage: 'quotaCost',
    unpriced: 'muted',
  };

  const dataLine = (row: BreakdownRowViewModel, bold = false, selected = false): RichLine => {
    const spans: RichLine = columns.flatMap((column, index) => {
      const cell = renderCell(column, column.render(row), widths[index]!);
      const role = CELL_ROLES[column.id];
      const attributes = bold || selected ? { bold: true } : undefined;
      return [
        { text: index === 0 ? (selected ? '▸' : ' ') : '  ' },
        role === undefined && attributes === undefined ? { text: cell } : { text: cell, role, attributes },
      ];
    });
    return spans;
  };

  const headerLine = (): RichLine =>
    columns.flatMap((column, index) => {
      const isSorted = column.id === sortedColumnId;
      const base = renderCell(column, headerText(column), widths[index]!);
      const lead = { text: index === 0 ? ' ' : '  ' };
      if (!isSorted) {
        return [lead, { text: base, role: 'tableHeader' as ThemeRole, attributes: { bold: true } }];
      }
      // split the arrow into its own accent span (k9s-style indicator)
      const arrowAt = base.lastIndexOf(arrow);
      if (arrowAt < 0) {
        return [lead, { text: base, role: 'tableHeader' as ThemeRole, attributes: { bold: true } }];
      }
      return [
        lead,
        { text: base.slice(0, arrowAt), role: 'tableHeader' as ThemeRole, attributes: { bold: true } },
        { text: arrow, role: 'sortIndicator' as ThemeRole, attributes: { bold: true } },
        { text: base.slice(arrowAt + arrow.length) },
      ];
    });

  const rule: RichLine = [
    {
      text: ` ${'─'.repeat(Math.min(width - 2, widths.reduce((a, b) => a + b + 2, -2)))}`,
      role: 'border',
    },
  ];

  const lines: RichLine[] = [headerLine(), rule];
  // window FOLLOWS the cursor: a fixed head slice let j/k walk onto
  // rows that were never drawn, and Enter opened an invisible model
  // (audit CX-23/GK-25)
  const capacity = Math.max(1, visibleRows);
  const { start } = tableWindow(model.rows.length, cursor, visibleRows);
  if (start > 0) {
    lines.push([{ text: `   … ${start} above`, role: 'muted' }]);
  }
  model.rows.slice(start, start + capacity).forEach((row, index) => {
    lines.push(dataLine(row, false, start + index === cursor));
  });
  const below = model.rows.length - (start + capacity);
  if (below > 0) {
    lines.push([{ text: `   … ${below} more`, role: 'muted' }]);
  }
  lines.push(rule);
  lines.push(dataLine(model.totals, true));
  return lines;
}


/**
 * The cursor-following window shared by the renderer AND the mouse
 * hit-test — computing it twice let clicks select a row four positions
 * off once the table scrolled (audit grok C3-05).
 */
export function tableWindow(
  rowCount: number,
  cursor: number,
  visibleRows: number,
): { start: number; hasAboveLine: boolean } {
  const capacity = Math.max(1, visibleRows);
  const start = Math.min(
    Math.max(0, cursor - capacity + 1),
    Math.max(0, rowCount - capacity),
  );
  return { start, hasAboveLine: start > 0 };
}

/** k9s-style context summary above the table. */
export function buildTableSummary(
  model: BreakdownTabViewModel,
  sort: SortSpec,
): RichLine {
  const noun = model.kind === 'agent' ? 'Agents' : 'Models';
  const arrow = sort.direction === 'asc' ? '↑' : '↓';
  return [
    { text: ` ${noun} [${model.rows.length}]`, role: 'accent', attributes: { bold: true } },
    { text: ` · prompts ${model.totals.promptCount.toLocaleString('en-US')} · calls ${model.totals.rowCount.toLocaleString('en-US')}`, role: 'muted' },
    { text: ` · sort ${SORT_LABELS[sort.column]}${arrow}`, role: 'sortIndicator' },
  ];
}
