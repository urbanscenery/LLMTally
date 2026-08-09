/** Number/cost formatting shared by TUI views. */

export function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return '?';
  }
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(1)}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}K`;
  }
  return String(Math.round(value));
}

export function formatUsdAmount(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
