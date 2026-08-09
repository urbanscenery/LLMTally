import { describe, expect, test } from 'bun:test';

import { sanitizeTerminalBlock, sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';

describe('sanitizeTerminalLine', () => {
  test('strips ESC/CSI/OSC/C1 control characters, CRLF, and tab', () => {
    // Arrange - ESC+CSI color, ESC+OSC title+BEL, C1 CSI, CRLF, tab
    const hostile = 'a\u001b[31mred\u001b]0;title\u0007b\u009b1mc\r\nd\te';

    // Act
    const cleaned = sanitizeTerminalLine(hostile);

    // Assert
    expect(cleaned).toBe('a[31mred]0;titleb1mcde');
  });

  test('keeps normal unicode intact', () => {
    // Act & Assert
    expect(sanitizeTerminalLine('claude-fable-5 - hangul ok')).toBe('claude-fable-5 - hangul ok');
  });
});

describe('sanitizeTerminalBlock', () => {
  test('keeps LF and tab but strips other controls', () => {
    // Arrange
    const hostile = 'line1\u001b[2Jx\nline2\tcol';

    // Act
    const cleaned = sanitizeTerminalBlock(hostile);

    // Assert
    expect(cleaned).toBe('line1[2Jx\nline2\tcol');
  });
});
