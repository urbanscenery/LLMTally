import type { ReportRange } from './types.ts';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const ALL_TIME_RANGE: ReportRange = {
  fromDate: null,
  toDate: null,
};

/** Strict YYYY-MM-DD with a real calendar date (timezone-independent). */
export function isValidReportDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

/**
 * Validation only — epoch conversion is deferred to the repository so
 * the boundaries use SQLite's localtime, the same clock that buckets
 * rows by day. Both ends are inclusive local calendar dates.
 */
export function buildReportRange(
  fromDate: string | null,
  toDate: string | null,
): ReportRange | { readonly error: string } {
  if (fromDate !== null && !isValidReportDate(fromDate)) {
    return { error: `--from "${fromDate}" is not a valid YYYY-MM-DD date` };
  }
  if (toDate !== null && !isValidReportDate(toDate)) {
    return { error: `--to "${toDate}" is not a valid YYYY-MM-DD date` };
  }
  if (fromDate !== null && toDate !== null && fromDate > toDate) {
    return { error: '--from must not be after --to' };
  }
  return { fromDate, toDate };
}
