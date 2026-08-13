import { describe, expect, test } from 'bun:test';

import { TuiController } from '@llmtally/tui/controller.ts';
import { FakeScreen } from './helpers.ts';

function makeController(screen: FakeScreen): TuiController {
  return new TuiController({ screen, nowUtc: () => 1_800_000_000 });
}

describe('TuiController', () => {
  test('renders an initial frame on start', () => {
    // Arrange
    const screen = new FakeScreen();
    const controller = makeController(screen);

    // Act
    controller.start();

    // Assert
    expect(screen.frames).toHaveLength(1);
    expect(screen.lastFrame()[0]).toContain('▸[1] Overview');
  });

  test('tab, shift-tab, arrows, and digits switch tabs', () => {
    // Arrange
    const screen = new FakeScreen();
    const controller = makeController(screen);
    controller.start();

    // Act & Assert
    screen.pressKey('tab');
    expect(controller.getState().activeTab).toBe('accounts');
    screen.pressKey('tab', { shift: true });
    expect(controller.getState().activeTab).toBe('overview');
    screen.pressKey('left');
    expect(controller.getState().activeTab).toBe('doctor');
    screen.pressKey('right');
    expect(controller.getState().activeTab).toBe('overview');
    screen.pressKey('3');
    expect(controller.getState().activeTab).toBe('agents');
  });

  test('q quits, resolves done, and destroys the screen exactly once', async () => {
    // Arrange
    const screen = new FakeScreen();
    const controller = makeController(screen);
    controller.start();

    // Act
    screen.pressKey('q');
    screen.pressKey('q');
    controller.stop();
    await controller.done;

    // Assert
    expect(screen.destroyCount).toBe(1);
    expect(controller.getState().closing).toBe(true);
  });

  test('ctrl-c quits like q', async () => {
    // Arrange
    const screen = new FakeScreen();
    const controller = makeController(screen);
    controller.start();

    // Act
    screen.pressKey('c', { ctrl: true });
    await controller.done;

    // Assert
    expect(screen.destroyCount).toBe(1);
  });

  test('resize triggers a re-render at the new dimensions', () => {
    // Arrange
    const screen = new FakeScreen(80, 24);
    const controller = makeController(screen);
    controller.start();

    // Act
    screen.emitResize(50, 14);

    // Assert
    expect(screen.lastFrame()).toHaveLength(14);
    expect(Bun.stringWidth(screen.lastFrame()[0] ?? '')).toBe(50);
  });

  test('keys after stop do not render new frames', () => {
    // Arrange
    const screen = new FakeScreen();
    const controller = makeController(screen);
    controller.start();
    const framesBefore = screen.frames.length;

    // Act
    controller.stop();
    screen.pressKey('tab');

    // Assert
    expect(screen.frames.length).toBe(framesBefore);
  });

  test('onTabChange fires only on real changes', () => {
    // Arrange
    const screen = new FakeScreen();
    const seen: string[] = [];
    const controller = new TuiController({
      screen,
      nowUtc: () => 0,
      onTabChange: (tab) => {
        seen.push(tab);
      },
    });
    controller.start();

    // Act
    screen.pressKey('2');
    screen.pressKey('2');
    screen.pressKey('4');

    // Assert
    expect(seen).toEqual(['accounts', 'models']);
  });
});

describe('help vs standing overlays (GK-23)', () => {
  test('? does not replace a confirm overlay with the help card', () => {
    const controller = makeController(new FakeScreen());
    controller.start();
    controller.setOverlay({
      kind: 'confirm',
      topic: 'daemon-install',
      title: 'Background collection',
      message: 'Install?',
      payload: '',
    });

    controller.handleKey({ name: '?', ctrl: false, shift: true });

    expect(controller.getState().overlay?.kind).toBe('confirm');
  });

  test('Esc still closes the confirm', () => {
    const controller = makeController(new FakeScreen());
    controller.start();
    controller.setOverlay({
      kind: 'confirm',
      topic: 'daemon-install',
      title: 'Background collection',
      message: 'Install?',
      payload: '',
    });

    controller.handleKey({ name: 'escape', ctrl: false, shift: false });

    expect(controller.getState().overlay).toBeNull();
  });
});
