/**
 * The cross-surface theme catalog: one palette list consumed by both
 * surfaces. The TUI imports it directly; the macOS app compiles a
 * generated Swift copy (packages/app/scripts/gen-theme-presets.ts) that
 * a test keeps in lockstep. Palette edits happen here and only here.
 */
import { saturate } from './color.ts';

export type ThemeAppearance = 'dark' | 'light';

export interface ThemePresetColors {
  readonly accent: string;
  /** Healthy/ok state (the App calls this "live"). */
  readonly live: string;
  readonly warn: string;
  readonly crit: string;
  /** Billable-cost highlight. */
  readonly spend: string;
  /**
   * Quota-cost highlight where a theme distinguishes it; surfaces
   * fall back to `spend` when absent.
   */
  readonly quota?: string;
  readonly background: string;
  readonly text: string;
  readonly secondary: string;
  readonly dim: string;
  readonly border: string;
  /** Focused-frame color where it differs from `accent`. */
  readonly activeBorder?: string;
}

export interface ThemePreset {
  readonly id: string;
  readonly label: string;
  readonly appearance: ThemeAppearance;
  readonly colors: ThemePresetColors;
}

function dark(id: string, label: string, colors: ThemePresetColors): ThemePreset {
  return { id, label, appearance: 'dark', colors };
}

function light(id: string, label: string, colors: ThemePresetColors): ThemePreset {
  return { id, label, appearance: 'light', colors };
}

/**
 * Editor palettes read fine in an editor but wash out at the small
 * sizes both surfaces draw (menu-bar wells, TUI gauges) — lift the
 * state colors a touch. Applied at assembly so the App codegen and the
 * TUI see identical values.
 */
const STATE_SATURATION_BOOST = 1.15;

function boostStateColors(preset: ThemePreset): ThemePreset {
  const colors = preset.colors;
  return {
    ...preset,
    colors: {
      ...colors,
      accent: saturate(colors.accent, STATE_SATURATION_BOOST),
      live: saturate(colors.live, STATE_SATURATION_BOOST),
      warn: saturate(colors.warn, STATE_SATURATION_BOOST),
      crit: saturate(colors.crit, STATE_SATURATION_BOOST),
      spend: saturate(colors.spend, STATE_SATURATION_BOOST),
      ...(colors.quota === undefined
        ? {}
        : { quota: saturate(colors.quota, STATE_SATURATION_BOOST) }),
      ...(colors.activeBorder === undefined
        ? {}
        : { activeBorder: saturate(colors.activeBorder, STATE_SATURATION_BOOST) }),
    },
  };
}

const RAW_PRESETS: readonly ThemePreset[] = [
  dark('catppuccin', 'Catppuccin Mocha', {
    accent: '#cba6f7',
    live: '#a6e3a1',
    warn: '#f9e2af',
    crit: '#f38ba8',
    spend: '#f38ba8',
    quota: '#89b4fa',
    background: '#1e1e2e',
    text: '#cdd6f4',
    secondary: '#a6adc8',
    dim: '#585b70',
    border: '#6c7086',
    activeBorder: '#b4befe',
  }),
  dark('onedark', 'One Dark', {
    accent: '#c678dd',
    live: '#98c379',
    warn: '#e5c07b',
    crit: '#e06c75',
    spend: '#d19a66',
    quota: '#61afef',
    background: '#282c34',
    text: '#abb2bf',
    secondary: '#828997',
    dim: '#5c6370',
    border: '#4b5263',
  }),
  dark('tokyo-night', 'Tokyo Night', {
    accent: '#9d7cd8',
    live: '#9ece6a',
    warn: '#e0af68',
    crit: '#f7768e',
    spend: '#ff9e64',
    quota: '#7aa2f7',
    background: '#1a1b26',
    text: '#c0caf5',
    secondary: '#9aa5ce',
    dim: '#414868',
    border: '#3b4261',
  }),
  dark('dracula', 'Dracula', {
    accent: '#ff79c6',
    live: '#50fa7b',
    warn: '#ffb86c',
    crit: '#ff5555',
    spend: '#bd93f9',
    quota: '#8be9fd',
    background: '#282a36',
    text: '#f8f8f2',
    secondary: '#bfbfbf',
    dim: '#44475a',
    border: '#6272a4',
  }),
  dark('monokai', 'Monokai', {
    accent: '#f92672',
    live: '#a6e22e',
    warn: '#fd971f',
    crit: '#c4265e',
    spend: '#e6db74',
    quota: '#66d9ef',
    background: '#272822',
    text: '#f8f8f2',
    secondary: '#cfcfc2',
    dim: '#75715e',
    border: '#49483e',
  }),
  dark('vue', 'Vue Dark', {
    accent: '#42b883',
    live: '#42d392',
    warn: '#ffc517',
    crit: '#ed3c50',
    spend: '#ff7043',
    quota: '#64b5f6',
    background: '#273849',
    text: '#e5eef5',
    secondary: '#9fb3c8',
    dim: '#4d6174',
    border: '#3d5163',
  }),
  dark('material', 'Material Dark', {
    accent: '#c792ea',
    live: '#c3e88d',
    warn: '#ffcb6b',
    crit: '#f07178',
    spend: '#f78c6c',
    quota: '#82aaff',
    background: '#263238',
    text: '#eeffff',
    secondary: '#b2ccd6',
    dim: '#546e7a',
    border: '#37474f',
  }),
  dark('night-owl', 'Night Owl', {
    accent: '#82aaff',
    live: '#addb67',
    warn: '#ecc48d',
    crit: '#ef5350',
    spend: '#f78c6c',
    quota: '#c792ea',
    background: '#011627',
    text: '#d6deeb',
    secondary: '#5f7e97',
    dim: '#4b6479',
    border: '#1d3b53',
  }),
  dark('cobalt2', 'Cobalt2', {
    accent: '#ffc600',
    live: '#3ad900',
    warn: '#ff9d00',
    crit: '#ff2600',
    spend: '#ff628c',
    quota: '#2affdf',
    background: '#193549',
    text: '#ffffff',
    secondary: '#9effff',
    dim: '#406288',
    border: '#1f4662',
  }),
  dark('mono-dark', 'Mono Dark', {
    accent: '#eeeeee',
    live: '#cfcfcf',
    warn: '#8a8a8a',
    crit: '#ffffff',
    spend: '#b0b0b0',
    quota: '#888888',
    background: '#000000',
    text: '#eeeeee',
    secondary: '#b0b0b0',
    dim: '#555555',
    border: '#333333',
  }),
  light('github', 'GitHub Light', {
    accent: '#cf222e',
    live: '#1a7f37',
    warn: '#9a6700',
    crit: '#a40e26',
    spend: '#bc4c00',
    quota: '#0969da',
    background: '#ffffff',
    text: '#1f2328',
    secondary: '#59636e',
    dim: '#8c959f',
    border: '#d0d7de',
  }),
  light('solarized', 'Solarized Light', {
    accent: '#859900',
    live: '#2aa198',
    warn: '#b58900',
    crit: '#dc322f',
    spend: '#cb4b16',
    quota: '#268bd2',
    background: '#fdf6e3',
    text: '#657b83',
    secondary: '#839496',
    dim: '#93a1a1',
    border: '#eee8d5',
  }),
  light('onelight', 'One Light', {
    accent: '#a626a4',
    live: '#50a14f',
    warn: '#c18401',
    crit: '#e45649',
    spend: '#986801',
    quota: '#4078f2',
    background: '#fafafa',
    text: '#383a42',
    secondary: '#696c77',
    dim: '#a0a1a7',
    border: '#e5e5e6',
  }),
  light('monokai-light', 'Monokai Light', {
    accent: '#e14775',
    live: '#269d69',
    warn: '#cc7a0a',
    crit: '#b02a56',
    spend: '#e16032',
    quota: '#1c8ca8',
    background: '#f8efe7',
    text: '#3e3d32',
    secondary: '#6e6d5e',
    dim: '#a6a595',
    border: '#e4d8cc',
  }),
  light('vue-light', 'Vue Light', {
    accent: '#42b883',
    live: '#349469',
    warn: '#e7a500',
    crit: '#d63c4e',
    spend: '#e96900',
    quota: '#2973b7',
    background: '#f9f9f9',
    text: '#2c3e50',
    secondary: '#5d6d7e',
    dim: '#95a5a6',
    border: '#e0e0e0',
  }),
  light('material-light', 'Material Light', {
    accent: '#7c4dff',
    live: '#91b859',
    warn: '#e2931d',
    crit: '#e53935',
    spend: '#f76d47',
    quota: '#6182b8',
    background: '#fafafa',
    text: '#37474f',
    secondary: '#607d8b',
    dim: '#90a4ae',
    border: '#eceff1',
  }),
  light('night-owl-light', 'Night Owl Light', {
    accent: '#4876d6',
    live: '#08916a',
    warn: '#daaa01',
    crit: '#de3d3b',
    spend: '#c96765',
    quota: '#994cc3',
    background: '#fbfbfb',
    text: '#403f53',
    secondary: '#697098',
    dim: '#90a7b2',
    border: '#d9d9d9',
  }),
  light('cobalt2-light', 'Cobalt2 Light', {
    accent: '#0088ff',
    live: '#1f9d55',
    warn: '#c78100',
    crit: '#d92600',
    spend: '#d6437f',
    quota: '#7a3e9d',
    background: '#eaf2fa',
    text: '#193549',
    secondary: '#3f6d94',
    dim: '#7d9cb5',
    border: '#c7dbeb',
  }),
  light('mono-light', 'Mono Light', {
    accent: '#111111',
    live: '#333333',
    warn: '#777777',
    crit: '#000000',
    spend: '#555555',
    quota: '#999999',
    background: '#ffffff',
    text: '#111111',
    secondary: '#555555',
    dim: '#888888',
    border: '#dddddd',
  }),
];

export const THEME_PRESETS: readonly ThemePreset[] = RAW_PRESETS.map(boostStateColors);

/**
 * Ids either surface stored before the catalog was shared, resolved on
 * read so remembered preferences keep working.
 */
export const LEGACY_THEME_IDS: Readonly<Record<string, string>> = {
  // the TUI's original name for Catppuccin Mocha
  default: 'catppuccin',
  // the App's pre-catalog spelling
  tokyonight: 'tokyo-night',
};

/**
 * App-only additions: its old 'mono' preset was the dark mono palette.
 * The TUI must NOT apply this one — there 'mono' means "no colors".
 */
export const APP_LEGACY_THEME_IDS: Readonly<Record<string, string>> = {
  ...LEGACY_THEME_IDS,
  mono: 'mono-dark',
};
