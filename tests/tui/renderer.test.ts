import { describe, expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';

import { plainLine, span } from '@llmtally/tui/rich-text.ts';
import { wrapRenderer } from '@llmtally/tui/renderer.ts';

describe('opentui adapter', () => {
  test('setFrame draws lines into the captured char frame', async () => {
    // Arrange
    const setup = await createTestRenderer({ width: 40, height: 6 });
    const screen = wrapRenderer(setup.renderer);

    // Act
    screen.setFrame([plainLine('HELLO-TUI'), plainLine('line-two')]);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();

    // Assert
    expect(screen.width).toBe(40);
    expect(screen.height).toBe(6);
    expect(frame).toContain('HELLO-TUI');
    expect(frame).toContain('line-two');
    screen.destroy();
  });

  test('key events reach the handler through the adapter', async () => {
    // Arrange
    const setup = await createTestRenderer({ width: 40, height: 6 });
    const screen = wrapRenderer(setup.renderer);
    const seen: string[] = [];
    screen.onKey((key) => {
      seen.push(key.name);
    });

    // Act
    setup.mockInput.pressKey('q');
    await setup.renderOnce();

    // Assert
    expect(seen).toContain('q');
    screen.destroy();
  });

  test('destroy is idempotent through the adapter', async () => {
    // Arrange
    const setup = await createTestRenderer({ width: 20, height: 4 });
    const screen = wrapRenderer(setup.renderer);

    // Act & Assert — second call must not throw
    screen.destroy();
    screen.destroy();
  });
});

describe('styled frame path', () => {
  test('styled spans render through StyledText without altering glyphs', async () => {
    // Arrange
    const setup = await createTestRenderer({ width: 40, height: 4 });
    const screen = wrapRenderer(setup.renderer);

    // Act — bold span forces the StyledText branch
    screen.setFrame([
      [span('BOLD-BIT', 'accent', { bold: true }), span(' plain-tail')],
      plainLine('second'),
    ]);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();

    // Assert
    expect(frame).toContain('BOLD-BIT plain-tail');
    expect(frame).toContain('second');
    screen.destroy();
  });
});
