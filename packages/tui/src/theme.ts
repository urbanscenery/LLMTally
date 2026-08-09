import { buildRamp } from './gradient.ts';
import type { RampStops } from './gradient.ts';
import type { ThemeRole } from './rich-text.ts';

/**
 * Semantic palette (posting-style roles) plus btop-style ramp stops.
 * Backgrounds are intentionally absent: the user's terminal background
 * is respected everywhere.
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
  readonly actualCost: string;
  readonly nominalCost: string;
}

export interface ThemeDefinition {
  readonly name: string;
  readonly palette: ThemePalette;
  readonly ramps: {
    readonly quota: RampStops;
    readonly chart: RampStops;
  };
}

export interface ResolvedStyle {
  readonly color: string | null;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

export interface ResolvedTheme {
  readonly name: string;
  resolve(role: ThemeRole): ResolvedStyle;
}

const CATPPUCCIN_MOCHA: ThemeDefinition = {
  name: 'default',
  palette: {
    accent: '#cba6f7',
    border: '#6c7086',
    activeBorder: '#b4befe',
    text: '#cdd6f4',
    secondary: '#a6adc8',
    dim: '#585b70',
    ok: '#a6e3a1',
    warn: '#f9e2af',
    crit: '#f38ba8',
    actualCost: '#f38ba8',
    nominalCost: '#89b4fa',
  },
  ramps: {
    quota: ['#a6e3a1', '#f9e2af', '#f38ba8'],
    chart: ['#585b70', '#cba6f7'],
  },
};

const TOKYO_NIGHT: ThemeDefinition = {
  name: 'tokyo-night',
  palette: {
    accent: '#7dcfff',
    border: '#565f89',
    activeBorder: '#7aa2f7',
    text: '#c0caf5',
    secondary: '#9aa5ce',
    dim: '#414868',
    ok: '#9ece6a',
    warn: '#e0af68',
    crit: '#f7768e',
    actualCost: '#f7768e',
    nominalCost: '#bb9af7',
  },
  ramps: {
    quota: ['#9ece6a', '#e0af68', '#f7768e'],
    chart: ['#414868', '#7dcfff'],
  },
};

const DRACULA: ThemeDefinition = {
  name: 'dracula',
  palette: {
    accent: '#bd93f9',
    border: '#6272a4',
    activeBorder: '#ff79c6',
    text: '#f8f8f2',
    secondary: '#e6e6e6',
    dim: '#44475a',
    ok: '#50fa7b',
    warn: '#f1fa8c',
    crit: '#ff5555',
    actualCost: '#ff5555',
    nominalCost: '#8be9fd',
  },
  ramps: {
    quota: ['#50fa7b', '#f1fa8c', '#ff5555'],
    chart: ['#44475a', '#bd93f9'],
  },
};

export const THEMES: readonly ThemeDefinition[] = [CATPPUCCIN_MOCHA, TOKYO_NIGHT, DRACULA];

export function themeNames(): readonly string[] {
  return THEMES.map((theme) => theme.name);
}

/** NO_COLOR / dumb terminals: structure and attributes only, no colors. */
export const MONO_THEME: ResolvedTheme = {
  name: 'mono',
  resolve(role) {
    return { color: null, ...attributesFor(role) };
  },
};

function attributesFor(role: ThemeRole): { bold?: boolean; dim?: boolean } {
  switch (role) {
    case 'selected':
    case 'actualCost':
    case 'tableHeader':
    case 'key':
      return { bold: true };
    case 'nominalCost':
    case 'dim':
    case 'muted':
    case 'meterTrack':
      return { dim: true };
    default:
      return {};
  }
}

export function resolveTheme(definition: ThemeDefinition): ResolvedTheme {
  const quotaRamp = buildRamp(definition.ramps.quota);
  const chartRamp = buildRamp(definition.ramps.chart);
  const palette = definition.palette;
  const base: Record<string, string | null> = {
    default: null,
    muted: palette.secondary,
    dim: palette.dim,
    accent: palette.accent,
    border: palette.border,
    selected: palette.accent,
    success: palette.ok,
    warning: palette.warn,
    danger: palette.crit,
    actualCost: palette.actualCost,
    nominalCost: palette.nominalCost,
    meterTrack: palette.dim,
    tableHeader: palette.secondary,
    sortIndicator: palette.accent,
    key: palette.accent,
  };
  return {
    name: definition.name,
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
  return THEMES.find((theme) => theme.name === name) ?? null;
}
