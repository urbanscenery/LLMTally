import { describe, expect, test } from 'bun:test';

import { TuiController } from '@llmtally/tui/controller.ts';
import { HELP_OVERLAY, makePicker, movePicker, selectedOption } from '@llmtally/tui/overlay.ts';
import { withActiveTab } from '@llmtally/tui/state.ts';
import { FakeScreen } from './helpers.ts';

const OPTIONS = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B', disabled: true },
  { id: 'c', label: 'C' },
];

describe('picker navigation', () => {
  test('opens on the current value and skips disabled options', () => {
    // Arrange
    const picker = makePicker('theme', 'Theme', OPTIONS, 'c');

    // Act & Assert — wrapping never lands on the disabled entry
    expect(selectedOption(picker)?.id).toBe('c');
    expect(selectedOption(movePicker(picker, 1))?.id).toBe('a');
    expect(selectedOption(movePicker(picker, -1))?.id).toBe('a');
  });

  test('an unknown current value falls back to the first usable option', () => {
    // Act & Assert
    expect(selectedOption(makePicker('theme', 'Theme', OPTIONS, 'gone'))?.id).toBe('a');
  });
});

describe('overlay input ownership (review regression)', () => {
  function setup() {
    const screen = new FakeScreen();
    const accountKeys: string[] = [];
    const controller = new TuiController({
      screen,
      nowUtc: () => 0,
      onAccountsKey: (key) => {
        accountKeys.push(key.name);
        return true;
      },
    });
    controller.commit(withActiveTab(controller.getState(), 'accounts'));
    controller.start();
    return { screen, controller, accountKeys };
  }

  test('an open help sheet does not let account actions fire behind it', () => {
    // Arrange
    const { screen, controller, accountKeys } = setup();
    controller.setOverlay(HELP_OVERLAY);

    // Act — n and x would store or forget credentials without confirmation
    screen.pressKey('n');
    screen.pressKey('x');

    // Assert
    expect(accountKeys).toEqual([]);
    expect(controller.getState().overlay).toEqual(HELP_OVERLAY);
  });

  test('an open confirmation does not let another action replace it', () => {
    // Arrange
    const { screen, controller, accountKeys } = setup();
    controller.setOverlay({
      kind: 'confirm',
      topic: 'account-switch',
      title: 'Switch account',
      message: 'Switch?',
      payload: 'uuid-1',
    });

    // Act
    screen.pressKey('x');
    screen.pressKey('s');

    // Assert — the pending confirmation is untouched
    expect(accountKeys).toEqual([]);
    expect(controller.getState().overlay).toMatchObject({ topic: 'account-switch', payload: 'uuid-1' });
  });

  test('a busy notice cannot be dismissed but quit still works', () => {
    // Arrange
    const { screen, controller } = setup();
    controller.setOverlay({ kind: 'notice', title: 'Switch account', message: 'working…', busy: true });

    // Act
    screen.pressKey('escape');
    screen.pressKey('return');

    // Assert
    expect(controller.getState().overlay).toMatchObject({ busy: true });
    screen.pressKey('q');
    expect(controller.getState().closing).toBe(true);
  });

  test('a finished notice closes on enter', () => {
    // Arrange
    const { screen, controller } = setup();
    controller.setOverlay({ kind: 'notice', title: 'Add account', message: 'stored', busy: false });

    // Act
    screen.pressKey('return');

    // Assert
    expect(controller.getState().overlay).toBeNull();
  });
});
