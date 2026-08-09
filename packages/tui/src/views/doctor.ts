import { joinLine, span } from '../rich-text.ts';
import type { RichLine, ThemeRole } from '../rich-text.ts';
import type { TuiState } from '../state.ts';
import { fitLine, padEndWidth, truncateToWidth } from '../text.ts';
import type { DoctorCheckViewModel } from '../view-model/doctor.ts';
import type { TabView, TabViewLine } from './shell.ts';

const ID_WIDTH = 24;

const STATUS_ROLE: Record<DoctorCheckViewModel['status'], ThemeRole> = {
  pass: 'success',
  warn: 'warning',
  fail: 'danger',
  skip: 'dim',
};

function checkLine(check: DoctorCheckViewModel, width: number): RichLine {
  const label = padEndWidth(truncateToWidth(check.id, ID_WIDTH), ID_WIDTH);
  const room = Math.max(10, width - ID_WIDTH - 12);
  return joinLine(
    ' ',
    span(padEndWidth(check.status.toUpperCase(), 5), STATUS_ROLE[check.status]),
    ' ',
    span(label, 'tableHeader'),
    ' ',
    span(truncateToWidth(check.message, room), 'default'),
  );
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
    lines.push(checkLine(check, width));
    if (check.remediation !== null && check.status !== 'pass') {
      lines.push(joinLine('       ', span(`→ ${truncateToWidth(check.remediation, width - 10)}`, 'muted')));
    }
  }
  return lines;
};
