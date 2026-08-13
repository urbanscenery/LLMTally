import { joinLine, span } from '../rich-text.ts';
import type { RichLine, ThemeRole } from '../rich-text.ts';
import type { TuiState } from '../state.ts';
import { fitLine, padEndWidth, truncateToWidth, wrapToWidth } from '../text.ts';
import type { DoctorCheckViewModel } from '../view-model/doctor.ts';
import type { TabView, TabViewLine } from './shell.ts';

const ID_WIDTH = 24;

const STATUS_ROLE: Record<DoctorCheckViewModel['status'], ThemeRole> = {
  pass: 'success',
  warn: 'warning',
  fail: 'danger',
  skip: 'dim',
};

/**
 * Diagnostic messages are what the user came here to read — wrap them
 * under the status column instead of eliding the tail.
 */
function checkLines(check: DoctorCheckViewModel, width: number): RichLine[] {
  const label = padEndWidth(truncateToWidth(check.id, ID_WIDTH), ID_WIDTH);
  const room = Math.max(10, width - ID_WIDTH - 12);
  const [first = '', ...rest] = wrapToWidth(check.message, room);
  const lines: RichLine[] = [
    joinLine(
      ' ',
      span(padEndWidth(check.status.toUpperCase(), 5), STATUS_ROLE[check.status]),
      ' ',
      span(label, 'tableHeader'),
      ' ',
      span(first, 'default'),
    ),
  ];
  const indent = ' '.repeat(8 + ID_WIDTH);
  for (const wrapped of rest) {
    lines.push(joinLine(indent, span(wrapped, 'default')));
  }
  return lines;
}

export const doctorTabView: TabView = (
  state: TuiState,
  width: number,
): readonly TabViewLine[] => {
  const resource = state.doctor;
  const model = resource.data;
  if (model === null) {
    return [
      fitLine(
        resource.phase === 'error'
          ? `  diagnostics unavailable: ${resource.error ?? 'unknown error'}`
          : '  running diagnostics…',
        width,
      ),
    ];
  }
  const { counts } = model;
  const lines: TabViewLine[] = [
    joinLine(
      ' ',
      span(`${counts.pass} pass`, 'success'),
      span('  ', 'default'),
      span(`${counts.warn} warn`, counts.warn > 0 ? 'warning' : 'dim'),
      span('  ', 'default'),
      span(`${counts.fail} fail`, counts.fail > 0 ? 'danger' : 'dim'),
      span('  ', 'default'),
      span(`${counts.skip} skip`, 'dim'),
    ),
    '',
  ];
  for (const check of model.checks) {
    lines.push(...checkLines(check, width));
    if (check.remediation !== null && check.status !== 'pass') {
      // remediation is recovery guidance — never elide it (same rule as
      // the accounts view)
      const [first = '', ...rest] = wrapToWidth(check.remediation, Math.max(10, width - 10));
      lines.push(joinLine('       ', span(`→ ${first}`, 'muted')));
      for (const wrapped of rest) {
        lines.push(joinLine('         ', span(wrapped, 'muted')));
      }
    }
  }
  return lines;
};
