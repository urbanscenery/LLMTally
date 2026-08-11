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

describe('terminal resize', () => {
  test('a renderer resize reaches the handler and updates the reported size', async () => {
    // Arrange
    const setup = await createTestRenderer({ width: 40, height: 6 });
    const screen = wrapRenderer(setup.renderer);
    const seen: Array<{ width: number; height: number }> = [];
    screen.onResize((width, height) => {
      seen.push({ width, height });
    });

    // Act
    setup.resize(60, 10);
    await setup.renderOnce();

    // Assert — the layout layer learns the new size immediately
    expect(seen.at(-1)).toEqual({ width: 60, height: 10 });
    expect(screen.width).toBe(60);
    expect(screen.height).toBe(10);
    screen.destroy();
  });

  test('the size poll catches a resize the event stream missed', async () => {
    // Arrange — the "terminal" changed but no resize event ever fired
    const setup = await createTestRenderer({ width: 40, height: 6 });
    let reported = { columns: 40, rows: 6 };
    const screen = wrapRenderer(setup.renderer, undefined, {
      resizePollMs: 10,
      readTerminalSize: () => reported,
    });
    const seen: Array<{ width: number; height: number }> = [];
    screen.onResize((width, height) => {
      seen.push({ width, height });
    });

    // Act — only the polled size changes
    reported = { columns: 72, rows: 14 };
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Assert — the poll noticed and drove the same resize path
    expect(seen.at(-1)).toEqual({ width: 72, height: 14 });
    expect(screen.width).toBe(72);
    screen.destroy();
  });
});
