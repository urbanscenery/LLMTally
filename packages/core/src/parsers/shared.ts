const MILLISECONDS_PER_SECOND = 1000;
const UTC_DESIGNATOR_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Rejects offset-less ISO strings: Date.parse would interpret them as
 * LOCAL time and silently skew ts_utc by the host timezone.
 */
export function parseUtcTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !UTC_DESIGNATOR_PATTERN.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    return null;
  }
  return Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
}

/**
 * Missing token fields count as zero; anything non-integer is invalid.
 * Values past MAX_SAFE_INTEGER are invalid too — Number.isInteger
 * accepts 2^53+1, but ledger arithmetic on such a value silently loses
 * precision and one corrupt line would poison every aggregate that
 * includes it (audit CX-17).
 */
export function asTokenCount(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 0;
  }
  if (!isNonNegativeInteger(value)) {
    return null;
  }
  return value;
}

/**
 * Hard per-event cap: no real prompt reaches a trillion tokens, and a
 * cap this far below 2^53 keeps SQL SUMs inside exact float range even
 * across millions of rows (audit codex C1-12).
 */
export const MAX_TOKENS_PER_EVENT = 1_000_000_000_000;

export function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TOKENS_PER_EVENT
  );
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
