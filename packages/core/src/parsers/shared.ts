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

/** Missing token fields count as zero; anything non-integer is invalid. */
export function asTokenCount(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
