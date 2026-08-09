import { closeSync, openSync, readSync } from 'node:fs';

const DEFAULT_CHUNK_BYTES = 1 << 20;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface JsonlLine {
  /** Decoded line without the terminator; null when the bytes are not valid UTF-8. */
  readonly text: string | null;
  readonly invalidUtf8: boolean;
  /** Byte offset of the first byte of the line. */
  readonly startOffset: number;
  /** Byte offset just past the newline terminator. */
  readonly endOffset: number;
}

export interface JsonlTail {
  readonly tailPending: boolean;
  readonly tailStartOffset: number | null;
  /** Highest offset the caller may safely persist as a resume cursor. */
  readonly nextOffset: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Streams newline-terminated lines between startOffset and ceilingBytes.
 * Bytes after the last newline are never decoded or consumed: the returned
 * tail marks where the next scan cycle must resume so a partially written
 * final line can be retried instead of lost.
 */
export function* readJsonlLines(
  path: string,
  startOffset: number,
  ceilingBytes: number,
  chunkBytes: number = DEFAULT_CHUNK_BYTES,
): Generator<JsonlLine, JsonlTail> {
  const fd = openSync(path, 'r');
  try {
    let carry: Uint8Array = new Uint8Array(0);
    let carryStart = startOffset;
    let position = startOffset;

    while (position < ceilingBytes) {
      const want = Math.min(chunkBytes, ceilingBytes - position);
      const buffer = Buffer.alloc(want);
      const bytesRead = readSync(fd, buffer, 0, want, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;

      const data = concatBytes(carry, buffer.subarray(0, bytesRead));
      const dataStart = carryStart;
      let lineStart = 0;
      let newlineIndex = data.indexOf(LINE_FEED, lineStart);
      while (newlineIndex !== -1) {
        yield decodeLine(
          data.subarray(lineStart, newlineIndex),
          dataStart + lineStart,
          dataStart + newlineIndex + 1,
        );
        lineStart = newlineIndex + 1;
        newlineIndex = data.indexOf(LINE_FEED, lineStart);
      }
      carry = data.subarray(lineStart);
      carryStart = dataStart + lineStart;
    }

    if (carry.length > 0) {
      return { tailPending: true, tailStartOffset: carryStart, nextOffset: carryStart };
    }
    return { tailPending: false, tailStartOffset: null, nextOffset: carryStart };
  } finally {
    closeSync(fd);
  }
}

function decodeLine(bytes: Uint8Array, startOffset: number, endOffset: number): JsonlLine {
  const content =
    bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN
      ? bytes.subarray(0, bytes.length - 1)
      : bytes;
  try {
    return { text: decoder.decode(content), invalidUtf8: false, startOffset, endOffset };
  } catch {
    return { text: null, invalidUtf8: true, startOffset, endOffset };
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right;
  }
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}
