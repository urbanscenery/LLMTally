import { describe, expect, test } from 'bun:test';

import {
  fitRichLine,
  frameText,
  isPlainFrame,
  joinLine,
  lineText,
  lineWidth,
  plainLine,
  span,
  truncateRichLine,
} from '@llmtally/tui/rich-text.ts';

describe('span invariants', () => {
  test('rejects escape bytes inside span text', () => {
    // Arrange
    const ESC = String.fromCharCode(27);

    // Act & Assert
    expect(() => span(`bad${ESC}[31m`)).toThrow('escape');
    expect(() => span('fine · 한글 ✓')).not.toThrow();
  });
});

describe('truncateRichLine', () => {
  test('cuts at a span boundary and keeps earlier styles intact', () => {
    // Arrange
    const line = joinLine(span('abcd', 'accent'), span('efgh', 'danger'));

    // Act
    const cut = truncateRichLine(line, 6);

    // Assert
    expect(lineText(cut)).toBe('abcde…');
    expect(cut[0]?.role).toBe('accent');
    expect(cut[1]?.role).toBe('danger');
    expect(lineWidth(cut)).toBe(6);
  });

  test('wide characters never split mid-grapheme', () => {
    // Arrange
    const line = plainLine('한글텍스트');

    // Act
    const cut = truncateRichLine(line, 5);

    // Assert
    expect(lineText(cut)).toBe('한글…');
    expect(lineWidth(cut)).toBe(5);
  });

  test('zero or negative width returns an empty line', () => {
    // Act & Assert
    expect(truncateRichLine(plainLine('abc'), 0)).toEqual([]);
  });
});

describe('fitRichLine', () => {
  test('pads to the exact requested cell width', () => {
    // Act
    const fitted = fitRichLine(joinLine(span('ab', 'accent')), 10);

    // Assert
    expect(lineWidth(fitted)).toBe(10);
    expect(lineText(fitted)).toBe('ab        ');
    expect(fitted[0]?.role).toBe('accent');
  });

  test('over-wide styled lines truncate to exact width', () => {
    // Act
    const fitted = fitRichLine(joinLine(span('abcdefghij', 'muted')), 4);

    // Assert
    expect(lineWidth(fitted)).toBe(4);
  });
});

describe('frame helpers', () => {
  test('frameText and isPlainFrame reflect span roles', () => {
    // Arrange
    const plain = [plainLine('a'), plainLine('b')];
    const styled = [joinLine(span('a', 'accent'))];

    // Act & Assert
    expect(frameText(plain)).toEqual(['a', 'b']);
    expect(isPlainFrame(plain)).toBe(true);
    expect(isPlainFrame(styled)).toBe(false);
  });
});
