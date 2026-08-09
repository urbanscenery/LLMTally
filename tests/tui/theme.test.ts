import { describe, expect, test } from 'bun:test';

import { buildRamp, rampIndex } from '@llmtally/tui/gradient.ts';
import { MONO_THEME, THEMES, findTheme, resolveTheme, themeNames } from '@llmtally/tui/theme.ts';

describe('buildRamp', () => {
  test('two-color ramp hits both endpoints exactly', () => {
    // Act
    const ramp = buildRamp(['#000000', '#ffffff']);

    // Assert
    expect(ramp).toHaveLength(101);
    expect(ramp[0]).toBe('#000000');
    expect(ramp[100]).toBe('#ffffff');
    expect(ramp[50]).toBe('#808080');
  });

  test('three-color ramp places the middle stop at 50', () => {
    // Act
    const ramp = buildRamp(['#00ff00', '#ffff00', '#ff0000']);

    // Assert
    expect(ramp[0]).toBe('#00ff00');
    expect(ramp[50]).toBe('#ffff00');
    expect(ramp[100]).toBe('#ff0000');
  });

  test('invalid hex fails fast with a clear message', () => {
    // Act & Assert
    expect(() => buildRamp(['#nothex', '#ffffff'])).toThrow('invalid theme color');
  });

  test('rampIndex clamps to 0..100 and survives NaN', () => {
    // Act & Assert
    expect(rampIndex(-5)).toBe(0);
    expect(rampIndex(130)).toBe(100);
    expect(rampIndex(Number.NaN)).toBe(0);
  });
});

describe('themes', () => {
  test('three built-in themes resolve every static role', () => {
    // Arrange
    const roles = [
      'default',
      'muted',
      'dim',
      'accent',
      'border',
      'selected',
      'success',
      'warning',
      'danger',
      'actualCost',
      'nominalCost',
      'meterTrack',
      'tableHeader',
      'sortIndicator',
      'key',
    ] as const;

    // Act & Assert
    expect(themeNames()).toEqual(['default', 'tokyo-night', 'dracula']);
    for (const definition of THEMES) {
      const theme = resolveTheme(definition);
      for (const role of roles) {
        const style = theme.resolve(role);
        if (role !== 'default') {
          expect(style.color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  test('ramp roles map percent to gradient colors', () => {
    // Arrange
    const theme = resolveTheme(THEMES[0]!);

    // Act
    const low = theme.resolve('ramp:quota:0');
    const high = theme.resolve('ramp:quota:100');

    // Assert
    expect(low.color).toBe('#a6e3a1');
    expect(high.color).toBe('#f38ba8');
  });

  test('mono theme keeps structure attributes but no colors', () => {
    // Act & Assert
    expect(MONO_THEME.resolve('accent').color).toBeNull();
    expect(MONO_THEME.resolve('actualCost')).toMatchObject({ color: null, bold: true });
    expect(MONO_THEME.resolve('nominalCost')).toMatchObject({ color: null, dim: true });
  });

  test('findTheme returns null for unknown names', () => {
    // Act & Assert
    expect(findTheme('dracula')?.name).toBe('dracula');
    expect(findTheme('nope')).toBeNull();
  });
});
