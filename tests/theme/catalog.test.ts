import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import {
  APP_LEGACY_THEME_IDS,
  LEGACY_THEME_IDS,
  THEME_PRESETS,
} from '@llmtally/core/theme/presets.ts';
import { THEMES, canonicalThemeName, findTheme } from '@llmtally/tui/theme.ts';
import {
  GENERATED_SWIFT_PATH,
  renderThemePresetsSwift,
} from '../../packages/app/scripts/gen-theme-presets.ts';

describe('shared theme catalog', () => {
  test('every preset color is a #rrggbb hex and ids are unique', () => {
    // Act & Assert
    const ids = new Set<string>();
    for (const preset of THEME_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      for (const value of Object.values(preset.colors)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test('the TUI theme list is exactly the shared catalog', () => {
    // Act & Assert — same ids, same order, palettes from the catalog
    expect(THEMES.map((theme) => theme.name)).toEqual(THEME_PRESETS.map((preset) => preset.id));
    for (const [index, preset] of THEME_PRESETS.entries()) {
      const theme = THEMES[index]!;
      expect(theme.label).toBe(preset.label);
      expect(theme.requiresBackground).toBe(preset.appearance === 'light');
      expect(theme.palette.accent).toBe(preset.colors.accent);
      expect(theme.palette.ok).toBe(preset.colors.live);
      expect(theme.background).toBe(preset.colors.background);
    }
  });

  test('the committed Swift catalog matches the generator output', () => {
    // Arrange — bundle.sh regenerates; this catches a forgotten commit
    const committed = readFileSync(GENERATED_SWIFT_PATH, 'utf8');

    // Act & Assert
    expect(committed).toBe(renderThemePresetsSwift());
  });

  test('legacy ids resolve to catalog themes', () => {
    // Act & Assert — every alias target exists
    for (const target of Object.values(APP_LEGACY_THEME_IDS)) {
      expect(THEME_PRESETS.some((preset) => preset.id === target)).toBe(true);
    }
    // remembered TUI preferences from before the shared catalog
    expect(findTheme('default')?.name).toBe('catppuccin');
    expect(findTheme('tokyonight')?.name).toBe('tokyo-night');
    // the TUI must keep 'mono' as the no-colors mode, not a palette
    expect(canonicalThemeName('mono')).toBe('mono');
    expect(LEGACY_THEME_IDS['mono']).toBeUndefined();
    // the App's old 'mono' preset was the dark mono palette
    expect(APP_LEGACY_THEME_IDS['mono']).toBe('mono-dark');
  });
});
