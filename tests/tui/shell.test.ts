import { describe, expect, test } from 'bun:test';

import { createInitialState, withActiveTab } from '@llmtally/tui/state.ts';
import { frameText } from '@llmtally/tui/rich-text.ts';
import { renderShell } from '@llmtally/tui/views/shell.ts';

const NOW = 1_800_000_000;

describe('renderShell', () => {
  test('80x24 frame has exact dimensions and marks the active tab', () => {
    // Arrange
    const state = withActiveTab(createInitialState(), 'accounts');

    // Act
    const frame = frameText(renderShell(state, 80, 24, NOW));

    // Assert
    expect(frame).toHaveLength(24);
    for (const line of frame) {
      expect(Bun.stringWidth(line)).toBe(80);
    }
    expect(frame[0]).toContain('▸[2] Accounts');
    expect(frame[0]).toContain(' [1] Overview');
    expect(frame[23]).toContain('[q]uit');
    expect(frame[23]).toContain('not refreshed yet');
  });

  test('50x14 narrow frame still renders without negative widths', () => {
    // Act
    const frame = frameText(renderShell(createInitialState(), 50, 14, NOW));

    // Assert
    expect(frame).toHaveLength(14);
    for (const line of frame) {
      expect(Bun.stringWidth(line)).toBe(50);
    }
  });

  test('footer reports refresh age from lastCompletedAtUtc', () => {
    // Arrange
    const base = createInitialState();
    const state = {
      ...base,
      refresh: { ...base.refresh, lastCompletedAtUtc: NOW - 42 },
    };

    // Act
    const frame = frameText(renderShell(state, 80, 24, NOW));

    // Assert
    expect(frame[23]).toContain('local • auto off • updated 42s ago');
  });

  test('scan busy status appears in the footer', () => {
    // Arrange
    const base = createInitialState();
    const state = {
      ...base,
      refresh: { ...base.refresh, scanStatus: 'busy' as const },
    };

    // Act
    const frame = frameText(renderShell(state, 80, 24, NOW));

    // Assert
    expect(frame[23]).toContain('scan busy (daemon)');
  });
});
