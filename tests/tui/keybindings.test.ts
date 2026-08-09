import { describe, expect, test } from 'bun:test';

import { HELP_OVERLAY } from '@llmtally/tui/overlay.ts';

import { renderHelpOverlay } from '@llmtally/tui/components/help-overlay.ts';
import { TuiController } from '@llmtally/tui/controller.ts';
import { footerBindings, resolveBinding } from '@llmtally/tui/keybindings.ts';
import { frameText, lineWidth } from '@llmtally/tui/rich-text.ts';
import { createInitialState, withActiveTab, withOverlay } from '@llmtally/tui/state.ts';
import { FakeScreen } from './helpers.ts';

const NOW = 1_800_000_000;

function key(name: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}) {
  return { name, ctrl: modifiers.ctrl === true, shift: modifiers.shift === true };
}

describe('resolveBinding', () => {
  test('sort keys resolve only on breakdown tabs', () => {
    // Arrange
    const onOverview = createInitialState();
    const onAgents = withActiveTab(onOverview, 'agents');

    // Act & Assert
    expect(resolveBinding(key('c'), onOverview)).toBeNull();
    expect(resolveBinding(key('c'), onAgents)?.action).toBe('sort-cost');
  });

  test('open help blocks everything except quit and toggle', () => {
    // Arrange
    const helped = withOverlay(withActiveTab(createInitialState(), 'agents'), HELP_OVERLAY);

    // Act & Assert
    expect(resolveBinding(key('c'), helped)).toBeNull();
    expect(resolveBinding(key('r'), helped)).toBeNull();
    expect(resolveBinding(key('q'), helped)?.action).toBe('quit');
    expect(resolveBinding(key('escape'), helped)?.action).toBe('toggle-help');
    expect(resolveBinding(key('?'), helped)?.action).toBe('toggle-help');
  });

  test('shift-tab and left arrow both mean previous tab', () => {
    // Arrange
    const state = createInitialState();

    // Act & Assert
    expect(resolveBinding(key('tab', { shift: true }), state)?.action).toBe('previous-tab');
    expect(resolveBinding(key('left'), state)?.action).toBe('previous-tab');
    expect(resolveBinding(key('tab'), state)?.action).toBe('next-tab');
  });
});

describe('footerBindings', () => {
  test('sort hint appears only on breakdown tabs, priority ordered', () => {
    // Act
    const overviewHints = footerBindings(createInitialState()).map((b) => b.footer?.keys);
    const agentHints = footerBindings(withActiveTab(createInitialState(), 'agents')).map(
      (b) => b.footer?.keys,
    );

    // Assert
    expect(overviewHints).not.toContain('[d/c/t]');
    expect(agentHints).toContain('[d/c/t]');
    expect(agentHints[0]).toBe('[q]');
  });
});

describe('help overlay', () => {
  test('? opens the overlay, Esc closes it, background keys are blocked', () => {
    // Arrange
    const screen = new FakeScreen();
    const controller = new TuiController({ screen, nowUtc: () => NOW });
    controller.start();

    // Act — open help on agents tab, try to sort behind it
    screen.pressKey('3');
    screen.pressKey('?');
    const openFrame = screen.lastFrame().join('\n');
    screen.pressKey('c');
    const sortAfterBlocked = controller.getState().agentsSort;
    screen.pressKey('escape');

    // Assert
    expect(controller.getState().overlay).toBeNull();
    expect(openFrame).toContain('Help');
    expect(openFrame).toContain('Navigation');
    expect(sortAfterBlocked).toEqual({ column: 'rows', direction: 'desc' });
  });

  test('overlay frame is centered and width-bounded', () => {
    // Act
    const frame = renderHelpOverlay(100, 24);
    const text = frameText(frame);

    // Assert
    expect(frame).toHaveLength(24);
    expect(text.join('\n')).toContain('╭─ Help');
    expect(text.join('\n')).toContain('sort by actual cost');
    for (const line of frame) {
      expect(lineWidth(line)).toBeLessThanOrEqual(100);
    }
  });

  test('very narrow terminals still produce a bounded overlay', () => {
    // Act
    const frame = renderHelpOverlay(30, 12);

    // Assert
    expect(frame).toHaveLength(12);
    for (const line of frame) {
      expect(lineWidth(line)).toBeLessThanOrEqual(30);
    }
  });
});

describe('card geometry', () => {
  test('every border line of a titled card has identical width', async () => {
    // Arrange
    const { renderCard } = await import('@llmtally/tui/components/card.ts');
    const { lineWidth } = await import('@llmtally/tui/rich-text.ts');

    // Act
    const card = renderCard({
      title: 'claude-code — live',
      content: [[{ text: 'row one' }], [{ text: 'row two' }]],
      width: 60,
    });

    // Assert
    for (const line of card) {
      expect(lineWidth(line)).toBe(60);
    }
  });

  test('below the minimum width the card degrades to borderless', async () => {
    // Arrange
    const { renderCard, CARD_MIN_WIDTH } = await import('@llmtally/tui/components/card.ts');
    const { frameText } = await import('@llmtally/tui/rich-text.ts');

    // Act
    const card = renderCard({
      title: 'T',
      content: [[{ text: 'body' }]],
      width: CARD_MIN_WIDTH - 1,
    });

    // Assert
    expect(frameText(card).join('\n')).not.toContain('╭');
    expect(frameText(card).join('\n')).toContain('body');
  });
});

describe('review regressions', () => {
  test('kitty-style shifted ? still opens help', () => {
    // Arrange — kitty keyboard reports ? with shift=true
    const state = createInitialState();

    // Act & Assert
    expect(resolveBinding(key('?', { shift: true }), state)?.action).toBe('toggle-help');
    expect(resolveBinding(key('?'), state)?.action).toBe('toggle-help');
    // Tab still splits on shift
    expect(resolveBinding(key('tab', { shift: true }), state)?.action).toBe('previous-tab');
  });

  test('exact-fit span boundary still shows the ellipsis', async () => {
    // Arrange
    const { span, truncateRichLine, lineText, lineWidth } = await import(
      '@llmtally/tui/rich-text.ts'
    );
    const line = [span('ABCDE'), span('FGHIJ')];

    // Act — first span is exactly the requested width
    const cut = truncateRichLine(line, 5);

    // Assert — content loss is visible, width exact
    expect(lineText(cut)).toBe('ABCD…');
    expect(lineWidth(cut)).toBe(5);
  });

  test('wide unicode card titles stay inside the frame', async () => {
    // Arrange
    const { renderCard } = await import('@llmtally/tui/components/card.ts');
    const { lineWidth } = await import('@llmtally/tui/rich-text.ts');

    // Act
    const card = renderCard({
      title: '한글제목한글제목한글제목한글제목한글제목',
      content: [[{ text: 'row' }]],
      width: 40,
    });

    // Assert — every line including the title border is exactly 40 cells
    for (const line of card) {
      expect(lineWidth(line)).toBe(40);
    }
  });
});
