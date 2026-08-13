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

  test('a long input prompt wraps instead of truncating', async () => {
    // Arrange — narrow terminal: the prompt exceeds the card width
    const { renderInputOverlay } = await import('@llmtally/tui/components/overlay-view.ts');
    const { frameText } = await import('@llmtally/tui/rich-text.ts');

    // Act
    const lines = frameText(
      renderInputOverlay(
        {
          kind: 'input',
          title: 'Search prompts',
          prompt: 'Matches the words as one exact phrase in stored prompt text.',
          value: '',
        },
        44,
        24,
      ),
    ).join('\n');
    const flattened = lines.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');

    // Assert
    expect(flattened).toContain('stored prompt text.');
    expect(lines).not.toContain('…');
  });

  test('a picker option longer than the default card widens the card instead of eliding', async () => {
    // Arrange — labels are data (account addresses) and must stay whole
    const { renderPickerOverlay } = await import('@llmtally/tui/components/overlay-view.ts');
    const { frameText } = await import('@llmtally/tui/rich-text.ts');
    const label = 'claude — very.long.account.address@example-organization-name.com';

    // Act
    const lines = frameText(
      renderPickerOverlay(
        {
          kind: 'picker',
          topic: 'account-action',
          title: 'Account',
          options: [{ id: 'a', label, hint: 'active' }],
          index: 0,
        },
        100,
        24,
      ),
    ).join('\n');

    // Assert
    expect(lines).toContain('example-organization-name.com');
    expect(lines).not.toContain('…');
  });
});

describe('overlay height fitting', () => {
  const LONG_MESSAGE =
    'Stores the logins Claude Code, Codex, and OpenCode are using right now.\n' +
    '\n' +
    'To add a different account, sign in with it first:\n' +
    '  · claude-code: run "claude" and use /login\n' +
    '  · codex: press d here FIRST, then run "codex login"\n' +
    '  · opencode: run "opencode auth login"\n' +
    'then come back here and press n.\n' +
    '\n' +
    'Codex is the odd one out: "codex login" revokes whatever login auth.json still holds, which kills the account you just stored. Pressing d first stores it and moves the file out of the way, so there is nothing left to revoke.\n' +
    '\n' +
    'Store the current logins?';

  async function renderConfirm(width: number, height: number) {
    const { renderConfirmOverlay } = await import('@llmtally/tui/components/overlay-view.ts');
    const { frameText } = await import('@llmtally/tui/rich-text.ts');
    const lines = frameText(
      renderConfirmOverlay(
        { kind: 'confirm', topic: 'account-add', title: 'Add account', message: LONG_MESSAGE, payload: '' },
        width,
        height,
      ),
    );
    const flattened = lines.join('\n').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
    return { lines, flattened };
  }

  test('a tall confirm widens to fit the body height instead of losing its tail', async () => {
    // Act — 18 rows: too short at the preferred width, fits when wider
    const { lines, flattened } = await renderConfirm(80, 18);

    // Assert — everything is on screen, including the key hint
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(flattened).toContain('Store the current logins?');
    expect(flattened).toContain('confirm');
    expect(lines.join('\n')).not.toContain('…');
  });

  test('when no width can fit the height, the frame is dropped before the message', async () => {
    // Act — 8 rows can never hold this message
    const { lines, flattened } = await renderConfirm(80, 8);

    // Assert — the border gave way; the message did not
    expect(lines.join('\n')).not.toContain('╭');
    expect(flattened).toContain('Store the current logins?');
    expect(lines.join('\n')).not.toContain('…');
  });
});
