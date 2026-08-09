/**
 * Terminal UI: pure view functions producing styled lines, plus the
 * controller, loader, and refresh scheduler that drive them. Only
 * `renderer.ts` touches @opentui/core.
 */
export { TuiController } from './controller.ts';
export { TabLoader } from './loader.ts';
export { RefreshScheduler } from './refresh.ts';
export { createDefaultDataSource } from './data-source.ts';
export { createOpentuiScreen } from './renderer.ts';
export { renderShell } from './views/shell.ts';
export { THEMES, MONO_THEME, findTheme, resolveTheme, themeNames } from './theme.ts';
