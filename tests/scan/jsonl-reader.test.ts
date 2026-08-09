import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonlLine, JsonlTail } from '@llmtally/core/scan/jsonl-reader.ts';
import { readJsonlLines } from '@llmtally/core/scan/jsonl-reader.ts';
import { makeTempDir } from '../helpers.ts';

function writeTempFile(content: string | Uint8Array): string {
  const path = join(makeTempDir(), 'input.jsonl');
  writeFileSync(path, content);
  return path;
}

function drain(
  path: string,
  startOffset: number,
  ceiling: number,
  chunkBytes?: number,
): { lines: JsonlLine[]; tail: JsonlTail } {
  const lines: JsonlLine[] = [];
  const iterator = readJsonlLines(path, startOffset, ceiling, chunkBytes);
  let step = iterator.next();
  while (!step.done) {
    lines.push(step.value);
    step = iterator.next();
  }
  return { lines, tail: step.value };
}

describe('readJsonlLines', () => {
  test('yields complete lines with exact byte offsets', () => {
    // Arrange
    const path = writeTempFile('a\nbb\n');

    // Act
    const { lines, tail } = drain(path, 0, 5);

    // Assert
    expect(lines).toEqual([
      { text: 'a', invalidUtf8: false, startOffset: 0, endOffset: 2 },
      { text: 'bb', invalidUtf8: false, startOffset: 2, endOffset: 5 },
    ]);
    expect(tail).toEqual({ tailPending: false, tailStartOffset: null, nextOffset: 5 });
  });

  test('strips CR from CRLF lines while keeping byte offsets intact', () => {
    // Arrange
    const path = writeTempFile('x\r\ny\n');

    // Act
    const { lines } = drain(path, 0, 5);

    // Assert
    expect(lines[0]).toEqual({ text: 'x', invalidUtf8: false, startOffset: 0, endOffset: 3 });
    expect(lines[1]).toEqual({ text: 'y', invalidUtf8: false, startOffset: 3, endOffset: 5 });
  });

  test('flags invalid utf8 complete lines and still advances past them', () => {
    // Arrange
    const path = writeTempFile(new Uint8Array([0xff, 0xfe, 0x0a, 0x6f, 0x6b, 0x0a]));

    // Act
    const { lines, tail } = drain(path, 0, 6);

    // Assert
    expect(lines[0]).toEqual({ text: null, invalidUtf8: true, startOffset: 0, endOffset: 3 });
    expect(lines[1]?.text).toBe('ok');
    expect(tail.nextOffset).toBe(6);
  });

  test('holds a final line without newline as pending tail', () => {
    // Arrange
    const path = writeTempFile('ok\npartial');

    // Act
    const { lines, tail } = drain(path, 0, 10);

    // Assert
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('ok');
    expect(tail).toEqual({ tailPending: true, tailStartOffset: 3, nextOffset: 3 });
  });

  test('never reads past the scan ceiling', () => {
    // Arrange
    const path = writeTempFile('one\ntwo\nthree\n');

    // Act
    const { lines, tail } = drain(path, 0, 6);

    // Assert
    expect(lines.map((line) => line.text)).toEqual(['one']);
    expect(tail).toEqual({ tailPending: true, tailStartOffset: 4, nextOffset: 4 });
  });

  test('resumes from a byte offset mid-file', () => {
    // Arrange
    const path = writeTempFile('one\ntwo\nthree\n');

    // Act
    const { lines, tail } = drain(path, 4, 14);

    // Assert
    expect(lines.map((line) => line.text)).toEqual(['two', 'three']);
    expect(tail.nextOffset).toBe(14);
  });

  test('reassembles lines that span multiple read chunks', () => {
    // Arrange
    const path = writeTempFile('abcdefgh\nij\n');

    // Act
    const { lines, tail } = drain(path, 0, 12, 3);

    // Assert
    expect(lines.map((line) => line.text)).toEqual(['abcdefgh', 'ij']);
    expect(tail.tailPending).toBe(false);
  });

  test('treats multibyte utf8 content correctly across chunk boundaries', () => {
    // Arrange
    const path = writeTempFile('한글 프롬프트\nok\n');

    // Act
    const { lines } = drain(path, 0, Buffer.byteLength('한글 프롬프트\nok\n'), 4);

    // Assert
    expect(lines[0]?.text).toBe('한글 프롬프트');
    expect(lines[1]?.text).toBe('ok');
  });
});
