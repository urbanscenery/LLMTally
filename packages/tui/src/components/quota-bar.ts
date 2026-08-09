import { rampIndex } from '../gradient.ts';
import { joinLine, span } from '../rich-text.ts';
import type { RichLine } from '../rich-text.ts';
import { padStartWidth } from '../text.ts';
import type { QuotaBarViewModel } from '../view-model/accounts.ts';

export const QUOTA_WARN_PERCENT = 80;
export const QUOTA_CRITICAL_PERCENT = 95;

/**
 * Severity marker works without color (NO_COLOR): blank / [!] / [!!].
 */
export function severityMarker(usedPercent: number): string {
  if (usedPercent > QUOTA_CRITICAL_PERCENT) {
    return '[!!]';
  }
  if (usedPercent > QUOTA_WARN_PERCENT) {
    return '[!] ';
  }
  return '    ';
}

function severityRole(usedPercent: number): 'danger' | 'warning' | 'default' {
  if (usedPercent > QUOTA_CRITICAL_PERCENT) {
    return 'danger';
  }
  if (usedPercent > QUOTA_WARN_PERCENT) {
    return 'warning';
  }
  return 'default';
}

/**
 * btop-style cell-threshold gauge: cell i fills when the clamped
 * percent reaches round(i*100/width); filled cells take their ramp
 * color at that threshold. Geometry from fillRatio, label from the raw
 * percent (values over 100 stay visible). Fill is a distinct glyph so
 * the gauge reads without color.
 */
export function buildQuotaBar(bar: QuotaBarViewModel, gaugeWidth: number): RichLine {
  const inner = Math.max(4, gaugeWidth);
  const clamped = Math.round(bar.fillRatio * 100);
  const cells: RichLine[] = [];
  for (let cell = 1; cell <= inner; cell += 1) {
    const threshold = Math.round((cell * 100) / inner);
    if (clamped >= threshold && clamped > 0) {
      cells.push([span('■', `ramp:quota:${rampIndex(threshold)}`)]);
    } else {
      cells.push([span('·', 'meterTrack')]);
    }
  }
  const label = padStartWidth(`${bar.usedPercent.toFixed(1)}%`, 6);
  return joinLine(
    span('[', 'border'),
    ...cells,
    span(']', 'border'),
    span(label, severityRole(bar.usedPercent)),
  );
}

/** `resets 4h 11m` from now; empty when the reset time is unknown. */
export function describeReset(resetsAtUtc: number | null, nowUtc: number): string {
  if (resetsAtUtc === null) {
    return '';
  }
  const seconds = resetsAtUtc - nowUtc;
  if (seconds <= 0) {
    return 'resets soon';
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `resets ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `resets ${hours}h ${minutes}m`;
  }
  return `resets ${Math.max(1, minutes)}m`;
}
