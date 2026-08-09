const MAX_VARINT_BYTES = 10;
const MAX_FIELDS = 512;

export interface DecodedField {
  readonly fieldNumber: number;
  readonly wireType: 0 | 1 | 2 | 5;
  /** Present for wire type 0 when it fits a safe integer. */
  readonly varint: number | null;
  /** Present for wire types 1, 2, and 5. */
  readonly bytes: Uint8Array | null;
}

/**
 * Bounded protobuf wire decoder for the pinned Antigravity field map.
 * It never guesses: any malformed tag, oversized varint, or out-of-bounds
 * length makes the whole message undecodable (null) so the caller can
 * fail closed instead of ingesting half-parsed usage numbers.
 */
export function decodeMessage(bytes: Uint8Array): readonly DecodedField[] | null {
  const fields: DecodedField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (fields.length >= MAX_FIELDS) {
      return null;
    }
    const tag = readVarint(bytes, offset);
    if (tag === null || tag.value === null) {
      return null;
    }
    offset = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (fieldNumber === 0) {
      return null;
    }
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      if (value === null) {
        return null;
      }
      offset = value.next;
      // an oversized value (e.g. 64-bit session hashes) still has a valid
      // wire encoding — keep decoding and expose the value as unusable
      fields.push({ fieldNumber, wireType: 0, varint: value.value, bytes: null });
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      if (length === null || length.value === null || length.next + length.value > bytes.length) {
        return null;
      }
      fields.push({
        fieldNumber,
        wireType: 2,
        varint: null,
        bytes: bytes.subarray(length.next, length.next + length.value),
      });
      offset = length.next + length.value;
    } else if (wireType === 5 || wireType === 1) {
      const width = wireType === 5 ? 4 : 8;
      if (offset + width > bytes.length) {
        return null;
      }
      fields.push({
        fieldNumber,
        wireType,
        varint: null,
        bytes: bytes.subarray(offset, offset + width),
      });
      offset += width;
    } else {
      return null;
    }
  }
  return fields;
}

export function firstVarint(fields: readonly DecodedField[], fieldNumber: number): number | null {
  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 0) {
      return field.varint;
    }
  }
  return null;
}

/** True when any listed field EXISTS but its value overflowed (unusable). */
export function hasUnusableVarint(
  fields: readonly DecodedField[],
  fieldNumbers: readonly number[],
): boolean {
  return fields.some(
    (field) =>
      field.wireType === 0 && field.varint === null && fieldNumbers.includes(field.fieldNumber),
  );
}

export function firstBytes(
  fields: readonly DecodedField[],
  fieldNumber: number,
): Uint8Array | null {
  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 2) {
      return field.bytes;
    }
  }
  return null;
}

export function firstString(fields: readonly DecodedField[], fieldNumber: number): string | null {
  const bytes = firstBytes(fields, fieldNumber);
  if (bytes === null) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** value is null when the encoding is valid but exceeds a safe integer. */
function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number | null; readonly next: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
    const position = offset + index;
    if (position >= bytes.length) {
      return null;
    }
    const byte = bytes[position] ?? 0;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value: Number.isSafeInteger(value) ? value : null, next: position + 1 };
    }
    multiplier *= 128;
  }
  return null;
}
