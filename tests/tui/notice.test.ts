import { describe, expect, test } from 'bun:test';

import { noticeLines } from '@llmtally/tui/components/notice.ts';
import { lineText, lineWidth } from '@llmtally/tui/rich-text.ts';

const KEYCHAIN_WARNING = 'Keychain approval required. Choose Authorize Keychain in Accounts.';

describe('noticeLines', () => {
  test('keeps a short notice on one line behind its marker', () => {
    // Act
    const lines = noticeLines('! ', 'stale reading', 40, 'warning');

    // Assert
    expect(lines.map(lineText)).toEqual(['! stale reading']);
    expect(lines[0]?.[0]?.role).toBe('warning');
  });

  test('wraps a long notice in full instead of eliding it', () => {
    // Act
    const lines = noticeLines('! ', KEYCHAIN_WARNING, 30, 'warning');
    const joined = lines.map((line) => lineText(line).trim().replace(/^! /, '')).join(' ');

    // Assert — every word survives, nothing is replaced by an ellipsis
    expect(lines.length).toBeGreaterThan(1);
    expect(joined).toBe(KEYCHAIN_WARNING);
    expect(joined).not.toContain('…');
  });

  test('indents continuation lines under the text and respects the width', () => {
    // Act
    const lines = noticeLines('  ! ', KEYCHAIN_WARNING, 32, 'danger');

    // Assert
    expect(lineText(lines[0] ?? [])).toMatch(/^ {2}! /);
    for (const line of lines.slice(1)) {
      expect(lineText(line)).toMatch(/^ {4}\S/);
    }
    for (const line of lines) {
      expect(lineWidth(line)).toBeLessThanOrEqual(32);
    }
  });

  test('an empty marker yields plain wrapped lines', () => {
    // Act
    const lines = noticeLines('', 'no quota reading', 80, 'muted');

    // Assert
    expect(lines.map(lineText)).toEqual(['no quota reading']);
  });
});
