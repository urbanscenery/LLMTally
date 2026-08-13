/**
 * The cross-surface theme catalog: one palette list consumed by both
 * surfaces. The TUI imports it directly; the macOS app compiles a
 * generated Swift copy (packages/app/scripts/gen-theme-presets.ts) that
 * a test keeps in lockstep. Palette edits happen here and only here.
 */
export type ThemeAppearance = 'dark' | 'light';

export interface ThemePresetColors {
  readonly accent: string;
  /** Healthy/ok state (the App calls this "live"). */
  readonly live: string;
  readonly warn: string;
  readonly crit: string;
  /** Billable-cost highlight. */
  readonly actual: string;
  /**
   * Nominal-cost highlight where a theme distinguishes it; surfaces
   * fall back to `actual` when absent.
   */
  readonly nominal?: string;
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

export const THEME_PRESETS: readonly ThemePreset[] = [
  dark('catppuccin', 'Catppuccin Mocha', {
    accent: '#cba6f7',
    live: '#a6e3a1',
    warn: '#f9e2af',
    crit: '#f38ba8',
    actual: '#f38ba8',
    nominal: '#89b4fa',
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
    actual: '#d19a66',
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
    actual: '#ff9e64',
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
    actual: '#bd93f9',
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
    actual: '#e6db74',
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
    actual: '#ff7043',
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
    actual: '#f78c6c',
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
    actual: '#f78c6c',
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
    actual: '#ff628c',
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
    actual: '#b0b0b0',
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
    actual: '#bc4c00',
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
    actual: '#cb4b16',
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
    actual: '#986801',
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
    actual: '#e16032',
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
    actual: '#e96900',
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
    actual: '#f76d47',
    background: '#fafafa',
    text: '#37474f',
    secondary: '#607d8b',
    dim: '#90a4ae',
    border: '#eceff1',
  }),
  light('mono-light', 'Mono Light', {
    accent: '#111111',
    live: '#333333',
    warn: '#777777',
    crit: '#000000',
    actual: '#555555',
    background: '#ffffff',
    text: '#111111',
    secondary: '#555555',
    dim: '#888888',
    border: '#dddddd',
  }),
];

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
