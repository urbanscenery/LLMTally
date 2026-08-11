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

describe('overlay message wrapping', () => {
  test('a long notice message wraps instead of truncating', async () => {
    // Arrange — the switch-refusal message that used to end in "re…"
    const { renderNoticeOverlay } = await import('@llmtally/tui/components/overlay-view.ts');
    const { frameText } = await import('@llmtally/tui/rich-text.ts');
    const message =
      'the stored refresh token for yeontae.kim@kiwee.co.kr was rejected — log in as that account once (llmtally re-captures it automatically)';

    // Act
    const lines = frameText(
      renderNoticeOverlay({ kind: 'notice', title: 'Switch account', message, busy: false }, 80, 24),
    ).join('\n');
    const flattened = lines.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');

    // Assert — the tail is visible and nothing was elided (phrases can
    // straddle a wrap point, so match on the flattened text)
    expect(flattened).toContain('re-captures it automatically)');
    expect(lines).not.toContain('…');
  });

  test('a long confirm message wraps instead of truncating', async () => {
    // Arrange
    const { renderConfirmOverlay } = await import('@llmtally/tui/components/overlay-view.ts');
    const { frameText } = await import('@llmtally/tui/rich-text.ts');
    const message =
      'remove stored-account-with-a-rather-long-address@example-organization.com from the vault? its credentials are deleted permanently';

    // Act
    const lines = frameText(
      renderConfirmOverlay(
        { kind: 'confirm', topic: 'account-remove', title: 'Remove', message, payload: 'x' },
        80,
        24,
      ),
    ).join('\n');
    const flattened = lines.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');

    // Assert
    expect(flattened).toContain('deleted permanently');
    expect(lines).not.toContain('…');
  });
});
