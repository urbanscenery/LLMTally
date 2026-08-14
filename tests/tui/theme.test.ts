import { describe, expect, test } from 'bun:test';

import { buildRamp, rampIndex } from '@llmtally/tui/gradient.ts';
import {
  MONO_THEME,
  THEMES,
  findTheme,
  resolveTheme,
  shouldPaintSurface,
  themeNames,
} from '@llmtally/tui/theme.ts';

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
  test('built-in themes resolve every static role', () => {
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
      'spendCost',
      'quotaCost',
      'meterTrack',
      'tableHeader',
      'sortIndicator',
      'key',
    ] as const;

    // Act & Assert
    expect(themeNames()).toContain('catppuccin');
    expect(themeNames()).toContain('onedark');
    expect(themeNames()).toContain('github');
    expect(themeNames()).toHaveLength(19);
    for (const definition of THEMES) {
      const theme = resolveTheme(definition);
      for (const role of roles) {
        const style = theme.resolve(role);
        if (role !== 'default' || definition.requiresBackground) {
          expect(style.color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  test('App tokyo-night and dracula use the catalog key colors', () => {
    // Act — hexes carry the catalog's state-color saturation boost
    const tokyo = findTheme('tokyo-night');
    const dracula = findTheme('dracula');

    // Assert
    expect(tokyo?.palette.accent).toBe('#9b75df');
    expect(tokyo?.palette.ok).toBe('#9ed662');
    expect(tokyo?.palette.spendCost).toBe('#ff9e64');
    expect(dracula?.palette.accent).toBe('#ff79c6');
    expect(dracula?.palette.ok).toBe('#4bff79');
    expect(dracula?.palette.spendCost).toBe('#bc8dff');
  });

  test('light themes require a painted surface; dark themes do not', () => {
    // Act & Assert
    expect(findTheme('github')?.requiresBackground).toBe(true);
    expect(findTheme('onedark')?.requiresBackground).toBe(false);
    expect(shouldPaintSurface(findTheme('github'), false)).toBe(true);
    expect(shouldPaintSurface(findTheme('onedark'), false)).toBe(false);
    expect(shouldPaintSurface(findTheme('onedark'), true)).toBe(true);
    expect(shouldPaintSurface(findTheme('github'), false, true)).toBe(false);
  });

  test('painting binds default text and exposes the App surface hex', () => {
    // Arrange
    const github = findTheme('github')!;
    const onedark = findTheme('onedark')!;

    // Act
    const paintedLight = resolveTheme(github);
    const terminalDark = resolveTheme(onedark);
    const paintedDark = resolveTheme(onedark, { paintSurface: true });

    // Assert
    expect(paintedLight.background).toBe('#ffffff');
    expect(paintedLight.resolve('default').color).toBe('#1f2328');
    expect(terminalDark.background).toBeNull();
    expect(terminalDark.resolve('default').color).toBeNull();
    expect(paintedDark.background).toBe('#282c34');
    expect(paintedDark.resolve('default').color).toBe('#abb2bf');
  });

  test('ramp roles map percent to gradient colors', () => {
    // Arrange
    const theme = resolveTheme(THEMES[0]!);

    // Act
    const low = theme.resolve('ramp:quota:0');
    const high = theme.resolve('ramp:quota:100');

    // Assert
    // catalog state colors carry the saturation boost
    expect(low.color).toBe('#a2e89c');
    expect(high.color).toBe('#fb83a5');
  });

  test('mono theme keeps structure attributes but no colors', () => {
    // Act & Assert
    expect(MONO_THEME.resolve('accent').color).toBeNull();
    expect(MONO_THEME.resolve('spendCost')).toMatchObject({ color: null, bold: true });
    expect(MONO_THEME.resolve('quotaCost')).toMatchObject({ color: null, dim: true });
  });

  test('findTheme returns null for unknown names', () => {
    // Act & Assert
    expect(findTheme('dracula')?.name).toBe('dracula');
    expect(findTheme('nope')).toBeNull();
  });
});
