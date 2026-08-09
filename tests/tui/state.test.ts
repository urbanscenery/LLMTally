import { describe, expect, test } from 'bun:test';

import { createInitialState, nextTab, tabForDigit, withActiveTab } from '@llmtally/tui/state.ts';

describe('tui state', () => {
  test('starts on overview with idle resources', () => {
    // Act
    const state = createInitialState();

    // Assert
    expect(state.activeTab).toBe('overview');
    expect(state.accounts.phase).toBe('idle');
    expect(state.refresh.inFlight).toBe(false);
  });

  test('nextTab cycles forward and wraps backward', () => {
    // Arrange
    const state = createInitialState();

    // Act & Assert
    expect(nextTab(state, 1).activeTab).toBe('accounts');
    expect(nextTab(state, -1).activeTab).toBe('doctor');
  });

  test('withActiveTab returns the same object when unchanged', () => {
    // Arrange
    const state = createInitialState();

    // Act & Assert
    expect(withActiveTab(state, 'overview')).toBe(state);
    expect(withActiveTab(state, 'agents').activeTab).toBe('agents');
  });

  test('tabForDigit maps 1..6 and rejects the rest', () => {
    // Act & Assert
    expect(tabForDigit('1')).toBe('overview');
    expect(tabForDigit('4')).toBe('models');
    expect(tabForDigit('5')).toBe('search');
    expect(tabForDigit('6')).toBe('doctor');
    expect(tabForDigit('7')).toBeNull();
    expect(tabForDigit('x')).toBeNull();
  });
});
