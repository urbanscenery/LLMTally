import { describe, expect, test } from 'bun:test';

import { displayWidth, wrapToWidth } from '@llmtally/tui/text.ts';

describe('wrapToWidth', () => {
  test('wraps at word boundaries and loses nothing', () => {
    // Arrange — the real message that used to be truncated
    const message =
      'the stored refresh token for yeontae.kim@kiwee.co.kr was rejected — log in as that account once (llmtally re-captures it automatically)';

    // Act
    const lines = wrapToWidth(message, 40);

    // Assert — every cell fits, every word survives, no ellipsis
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(lines.join(' ')).toBe(message);
    expect(lines.join(' ')).not.toContain('…');
  });

  test('a token longer than the width is hard-broken, not dropped', () => {
    // Act
    const lines = wrapToWidth('id:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10);

    // Assert
    expect(lines.join('')).toBe('id:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  test('short text and degenerate widths stay sane', () => {
    // Act & Assert
    expect(wrapToWidth('hello', 40)).toEqual(['hello']);
    expect(wrapToWidth('', 40)).toEqual(['']);
    expect(wrapToWidth('hi there', 0)).toEqual(['hi there']);
  });
});
