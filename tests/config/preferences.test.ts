import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadUiPreferences, saveUiPreferences } from '@llmtally/core/config/preferences.ts';
import { makeTempDir } from '../helpers.ts';

function configPath(contents?: unknown): string {
  const path = join(makeTempDir(), 'config.json');
  if (contents !== undefined) {
    writeFileSync(path, JSON.stringify(contents, null, 2));
  }
  return path;
}

describe('ui preferences', () => {
  test('a saved theme and interval round-trip', () => {
    // Arrange
    const path = configPath();

    // Act
    expect(saveUiPreferences({ theme: 'dracula', autoRefreshSeconds: 300 }, path)).toBeNull();

    // Assert
    expect(loadUiPreferences(path)).toEqual({
      theme: 'dracula',
      autoRefreshSeconds: 300,
      paintBackground: undefined,
      chartStyle: null,
    });
  });

  test('saving one field leaves the other alone', () => {
    // Arrange
    const path = configPath();
    saveUiPreferences({ theme: 'dracula', autoRefreshSeconds: 60 }, path);

    // Act
    saveUiPreferences({ theme: 'tokyo-night' }, path);

    // Assert
    expect(loadUiPreferences(path)).toEqual({
      theme: 'tokyo-night',
      autoRefreshSeconds: 60,
      paintBackground: undefined,
      chartStyle: null,
    });
  });

  test('pricing overrides survive a theme change (review regression)', () => {
    // Arrange — a hand-written config, including one with no version key
    const versioned = configPath({
      version: 1,
      pricing: { modelAliases: { 'my-alias': 'gpt-4' } },
    });
    const unversioned = configPath({ pricing: { modelAliases: { 'my-alias': 'gpt-4' } } });

    // Act
    saveUiPreferences({ theme: 'dracula' }, versioned);
    saveUiPreferences({ theme: 'dracula' }, unversioned);

    // Assert — nothing the user wrote by hand is dropped
    for (const path of [versioned, unversioned]) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved.pricing).toEqual({ modelAliases: { 'my-alias': 'gpt-4' } });
      expect(saved.version).toBe(1);
      expect(saved.ui.theme).toBe('dracula');
    }
  });

  test('off is stored as null and read back as null', () => {
    // Arrange
    const path = configPath();

    // Act
    saveUiPreferences({ autoRefreshSeconds: null }, path);

    // Assert — null means off, distinct from "never chosen"
    expect(loadUiPreferences(path).autoRefreshSeconds).toBeNull();
  });

  test('a missing or malformed file yields empty preferences', () => {
    // Arrange
    const broken = configPath();
    writeFileSync(broken, 'not json');

    // Act & Assert
    expect(loadUiPreferences(join(makeTempDir(), 'none.json'))).toEqual({
      theme: null,
      autoRefreshSeconds: undefined,
      paintBackground: undefined,
      chartStyle: null,
    });
    expect(loadUiPreferences(broken).theme).toBeNull();
  });

  test('paintBackground round-trips and a theme save leaves it alone', () => {
    // Arrange
    const path = configPath();
    saveUiPreferences({ paintBackground: true }, path);

    // Act
    saveUiPreferences({ theme: 'onedark' }, path);

    // Assert
    expect(loadUiPreferences(path)).toEqual({
      theme: 'onedark',
      autoRefreshSeconds: undefined,
      paintBackground: true,
      chartStyle: null,
    });
  });

  test('chartStyle round-trips and a theme save leaves it alone', () => {
    // Arrange
    const path = configPath();
    saveUiPreferences({ chartStyle: 'heatmap' }, path);

    // Act
    saveUiPreferences({ theme: 'onedark' }, path);

    // Assert
    expect(loadUiPreferences(path).chartStyle).toBe('heatmap');
  });

  test('an unwritable path reports an error instead of throwing', () => {
    // Act
    const error = saveUiPreferences({ theme: 'dracula' }, '/proc/nope/config.json');

    // Assert
    expect(error).toContain('could not save preferences');
  });
});
