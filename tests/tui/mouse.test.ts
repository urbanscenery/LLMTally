import { describe, expect, test } from 'bun:test';

import { TuiController } from '@llmtally/tui/controller.ts';
import { HELP_OVERLAY } from '@llmtally/tui/overlay.ts';
import { tabAtColumn, tabBarSegments } from '@llmtally/tui/views/shell.ts';
import { FakeScreen } from './helpers.ts';

describe('tab bar hit map', () => {
  test('every label resolves to its own tab', () => {
    // Arrange
    const { hits } = tabBarSegments('overview');

    // Act & Assert — the first and last column of each label
    for (const hit of hits) {
      expect(tabAtColumn('overview', hit.start)).toBe(hit.tab);
      expect(tabAtColumn('overview', hit.end - 1)).toBe(hit.tab);
    }
  });

  test('the brand and the gaps between labels resolve to nothing', () => {
    // Act & Assert
    expect(tabAtColumn('overview', 0)).toBeNull();
    const first = tabBarSegments('overview').hits[0];
    expect(tabAtColumn('overview', (first?.start ?? 1) - 1)).toBeNull();
  });

  test('the map stays aligned when the active tab changes width', () => {
    // Arrange — the marker moves with the active tab
    const onModels = tabBarSegments('models');

    // Act & Assert
    for (const hit of onModels.hits) {
      expect(tabAtColumn('models', hit.start)).toBe(hit.tab);
    }
  });
});

describe('mouse handling', () => {
  function setup() {
    const screen = new FakeScreen();
    const clicks: { row: number; height: number }[] = [];
    const controller = new TuiController({
      screen,
      nowUtc: () => 0,
      onBodyClick: (row, height) => {
        clicks.push({ row, height });
        return true;
      },
    });
    controller.start();
    return { screen, controller, clicks };
  }

  test('clicking a tab label switches to it', () => {
    // Arrange
    const { screen, controller } = setup();
    const target = tabBarSegments(controller.getState().activeTab).hits[2];

    // Act
    screen.click((target?.start ?? 0) + 1, 0);

    // Assert
    expect(target).toBeDefined();
    expect(controller.getState().activeTab).toBe(target!.tab);
  });

  test('a body click reports a 0-based body row, not a screen row', () => {
    // Arrange
    const { screen, clicks } = setup();

    // Act — screen row 2 is the first body row
    screen.click(5, 2);
    screen.click(5, 7);

    // Assert
    expect(clicks.map((entry) => entry.row)).toEqual([0, 5]);
  });

  test('the separator row is not a body row', () => {
    // Arrange
    const { screen, clicks } = setup();

    // Act
    screen.click(5, 1);

    // Assert
    expect(clicks).toEqual([]);
  });

  test('scrolling is delivered as the arrow key the tab already handles', () => {
    // Arrange
    const screen = new FakeScreen();
    const keys: string[] = [];
    const controller = new TuiController({
      screen,
      nowUtc: () => 0,
      onAccountsKey: (key) => {
        keys.push(key.name);
        return true;
      },
    });
    controller.commit({ ...controller.getState(), activeTab: 'accounts' });
    controller.start();

    // Act
    screen.scroll('down');
    screen.scroll('up');

    // Assert
    expect(keys).toEqual(['down', 'up']);
  });

  test('a click does nothing while a modal is open', () => {
    // Arrange
    const { screen, controller, clicks } = setup();
    controller.setOverlay(HELP_OVERLAY);
    const target = tabBarSegments(controller.getState().activeTab).hits[2];

    // Act
    screen.click((target?.start ?? 0) + 1, 0);
    screen.click(5, 4);

    // Assert — neither the tab nor the body reacted
    expect(controller.getState().activeTab).toBe('overview');
    expect(clicks).toEqual([]);
  });
});
