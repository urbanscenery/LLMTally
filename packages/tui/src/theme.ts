import { LEGACY_THEME_IDS, THEME_PRESETS } from '@llmtally/core/theme/presets.ts';
import type { ThemePreset } from '@llmtally/core/theme/presets.ts';

import { buildRamp } from './gradient.ts';
import type { RampStops } from './gradient.ts';
import type { ThemeRole } from './rich-text.ts';

/**
 * Semantic palette (posting-style roles) plus btop-style ramp stops.
 * `background` is the App surface hex. It is painted only when
 * `shouldPaintSurface` says so — dark themes keep the terminal by
 * default; light themes always paint so their foreground stays readable.
 */
export interface ThemePalette {
  readonly accent: string;
  readonly border: string;
  readonly activeBorder: string;
  readonly text: string;
  readonly secondary: string;
  readonly dim: string;
  readonly ok: string;
  readonly warn: string;
  readonly crit: string;
  readonly spendCost: string;
  readonly quotaCost: string;
}

export interface ThemeDefinition {
  readonly name: string;
  readonly label: string;
  readonly requiresBackground: boolean;
  readonly background: string;
  readonly palette: ThemePalette;
  readonly ramps: {
    readonly quota: RampStops;
    readonly chart: RampStops;
  };
}

export interface ResolveThemeOptions {
  readonly paintSurface?: boolean;
}

export interface ResolvedStyle {
  readonly color: string | null;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

export interface ResolvedTheme {
  readonly name: string;
  /** Hex to clear the terminal with, or null to keep the terminal surface. */
  readonly background: string | null;
  resolve(role: ThemeRole): ResolvedStyle;
}

/**
 * The palettes live in the shared catalog (@llmtally/core/theme) so the
 * App and the TUI can never drift apart; this only maps the catalog
 * schema onto the TUI's role names.
 */
function fromPreset(preset: ThemePreset): ThemeDefinition {
  const colors = preset.colors;
  return {
    name: preset.id,
    label: preset.label,
    requiresBackground: preset.appearance === 'light',
    background: colors.background,
    palette: {
      accent: colors.accent,
      border: colors.border,
      activeBorder: colors.activeBorder ?? colors.accent,
      text: colors.text,
      secondary: colors.secondary,
      dim: colors.dim,
      ok: colors.live,
      warn: colors.warn,
      crit: colors.crit,
      spendCost: colors.spend,
      quotaCost: colors.quota ?? colors.spend,
    },
    ramps: {
      quota: [colors.live, colors.warn, colors.crit],
      chart: [colors.dim, colors.accent],
    },
  };
}

export const THEMES: readonly ThemeDefinition[] = THEME_PRESETS.map(fromPreset);

export function themeNames(): readonly string[] {
  return THEMES.map((theme) => theme.name);
}

/**
 * Resolves pre-catalog ids ('default', 'tokyonight') to their canonical
 * names. The App's old 'mono' is deliberately NOT mapped here — in the
 * TUI that name means "no colors", not the dark mono palette.
 */
export function canonicalThemeName(name: string): string {
  return LEGACY_THEME_IDS[name] ?? name;
}

/** Light themes, or a user who asked to paint a dark surface. */
export function shouldPaintSurface(
  definition: ThemeDefinition | null,
  userPaint: boolean,
  mono = false,
): boolean {
  if (mono || definition === null) {
    return false;
  }
  return definition.requiresBackground || userPaint;
}

/** NO_COLOR / dumb terminals: structure and attributes only, no colors. */
export const MONO_THEME: ResolvedTheme = {
  name: 'mono',
  background: null,
  resolve(role) {
    return { color: null, ...attributesFor(role) };
  },
};

function attributesFor(role: ThemeRole): { bold?: boolean; dim?: boolean } {
  switch (role) {
    case 'selected':
    case 'spendCost':
    case 'tableHeader':
    case 'key':
      return { bold: true };
    case 'quotaCost':
    case 'dim':
    case 'muted':
    case 'meterTrack':
      return { dim: true };
    default:
      return {};
  }
}

export function resolveTheme(
  definition: ThemeDefinition,
  options: ResolveThemeOptions = {},
): ResolvedTheme {
  const paint = shouldPaintSurface(definition, options.paintSurface === true);
  const quotaRamp = buildRamp(definition.ramps.quota);
  const chartRamp = buildRamp(definition.ramps.chart);
  const palette = definition.palette;
  const base: Record<string, string | null> = {
    default: paint ? palette.text : null,
    muted: palette.secondary,
    dim: palette.dim,
    accent: palette.accent,
    border: palette.border,
    selected: palette.accent,
    success: palette.ok,
    warning: palette.warn,
    danger: palette.crit,
    spendCost: palette.spendCost,
    quotaCost: palette.quotaCost,
    meterTrack: palette.dim,
    tableHeader: palette.secondary,
    sortIndicator: palette.accent,
    key: palette.accent,
  };
  return {
    name: definition.name,
    background: paint ? definition.background : null,
    resolve(role) {
      if (role.startsWith('ramp:')) {
        const [, ramp, indexText] = role.split(':');
        if (ramp !== 'quota' && ramp !== 'chart') {
          return { color: null };
        }
        const index = Math.max(0, Math.min(100, Number.parseInt(indexText ?? '0', 10) || 0));
        const color = ramp === 'quota' ? quotaRamp[index] : chartRamp[index];
        return { color: color ?? null };
      }
      return { color: base[role] ?? null, ...attributesFor(role) };
    },
  };
}

export function findTheme(name: string): ThemeDefinition | null {
  const canonical = canonicalThemeName(name);
  return THEMES.find((theme) => theme.name === canonical) ?? null;
}
