import type { CostResult } from '../pricing/types.ts';
import { sanitizeTerminalLine } from '../terminal/sanitize.ts';
import type { ReportBucket, ReportSummary } from './types.ts';

const USD_DECIMALS = 6;

const COLUMNS = [
  'Bucket',
  'Rows',
  'Input(raw)',
  'Cache Read',
  'Cache Write',
  'Output',
  'Reasoning',
  'Actual USD',
  'Nominal API-eq USD',
  'Unpriced',
] as const;

export function renderReportText(summary: ReportSummary): string {
  const header = [
    'LLMTally report',
    `Range: ${describeRange(summary)}`,
    `Grouping: ${summary.groupBy}${summary.agent === null ? '' : ` (agent: ${sanitizeCell(summary.agent)})`}`,
    `Pricing: ${summary.pricing.status}${
      summary.pricing.asOfUtc === null
        ? ''
        : ` (as of ${new Date(summary.pricing.asOfUtc * 1000).toISOString()})`
    }`,
    '',
  ];
  const rows = [...summary.buckets, summary.totals].map(bucketCells);
  const table = renderTable([Array.from(COLUMNS), ...rows]);
  const legend = [
    '',
    'Actual USD: source-reported billed cost (OpenCode/Cline).',
    'Nominal API-eq USD: current API-rate equivalent for subscription usage; NOT actual spend.',
    '* marks a priced subtotal: unpriced rows are excluded from the amount.',
  ];
  return [...header, ...table, ...legend].join('\n');
}

export function renderReportJson(summary: ReportSummary): string {
  return JSON.stringify(summary, null, 2);
}

/** Warning lines destined for stderr (kept out of table/JSON stdout). */
export function collectWarningLines(summary: ReportSummary): readonly string[] {
  const lines: string[] = [];
  for (const message of summary.pricing.warnings) {
    lines.push(sanitizeCell(`warning: ${message}`));
  }
  for (const warning of [...summary.totals.actual.warnings, ...summary.totals.nominal.warnings]) {
    const line = sanitizeCell(
      `warning: ${warning.code} for model "${warning.model}" (${warning.rows} rows)`,
    );
    if (!lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines;
}

function bucketCells(bucket: ReportBucket): string[] {
  return [
    sanitizeCell(bucket.key),
    formatCount(bucket.rowCount),
    formatCount(bucket.tokens.inputTokens),
    formatCount(bucket.tokens.cacheRead),
    formatCount(bucket.tokens.cacheWrite),
    formatCount(bucket.tokens.outputTokens),
    formatCount(bucket.tokens.reasoningTokens),
    formatCost(bucket.actual),
    formatCost(bucket.nominal),
    formatCount(bucket.unpricedRows),
  ];
}

function formatCost(cost: CostResult): string {
  if (cost.usd !== null) {
    return `$${cost.usd.toFixed(USD_DECIMALS)}`;
  }
  if (cost.pricedRows > 0) {
    return `$${cost.pricedSubtotalUsd.toFixed(USD_DECIMALS)}*`;
  }
  return '—';
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Source-derived strings (model names, warnings) could carry terminal
 * control characters; strip them from text output. JSON keeps originals.
 */
function sanitizeCell(value: string): string {
  return sanitizeTerminalLine(value);
}

function renderTable(rows: readonly (readonly string[])[]): string[] {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  '),
  );
}

function describeRange(summary: ReportSummary): string {
  const { fromDate, toDate } = summary.range;
  if (fromDate === null && toDate === null) {
    return 'all-time';
  }
  return `${fromDate ?? '...'} ~ ${toDate ?? '...'} (local time)`;
}
