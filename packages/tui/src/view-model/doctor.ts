import type { DoctorCheck } from '@llmtally/core/doctor/checks.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';

export interface DoctorCheckViewModel {
  readonly id: string;
  readonly status: DoctorCheck['status'];
  readonly message: string;
  readonly remediation: string | null;
}

export interface DoctorTabViewModel {
  readonly checks: readonly DoctorCheckViewModel[];
  readonly counts: Readonly<Record<DoctorCheck['status'], number>>;
}

/** Check text quotes file paths and tool output, so it is sanitized. */
export function toDoctorViewModel(checks: readonly DoctorCheck[]): DoctorTabViewModel {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  const mapped = checks.map((check) => {
    counts[check.status] += 1;
    return {
      id: sanitizeTerminalLine(check.id),
      status: check.status,
      message: sanitizeTerminalLine(check.message),
      remediation: check.remediation === undefined ? null : sanitizeTerminalLine(check.remediation),
    };
  });
  return { checks: mapped, counts };
}
