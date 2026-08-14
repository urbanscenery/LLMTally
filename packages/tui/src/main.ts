#!/usr/bin/env bun
/**
 * `llmtally` is the terminal app: it opens the dashboard directly.
 * There are no subcommands — everything (usage, accounts, quota,
 * diagnostics) lives in the tabs — so the only arguments are the few
 * options you would otherwise have to change inside the UI.
 */
import { defaultDatabasePath, isFirstRun } from '@llmtally/core/config/paths.ts';
import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import { resolve } from 'node:path';

import { createDefaultDataSource } from './data-source.ts';
import { createOpentuiScreen } from './renderer.ts';
import { createTuiSession } from './session.ts';
import { findTheme, themeNames } from './theme.ts';
import type { ResolvedTheme } from './theme.ts';
import { CHART_STYLES, isChartStyle } from './components/chart-style.ts';
import type { ChartStyle } from './components/chart-style.ts';

export const USAGE = `llmtally — per-prompt usage ledger for local AI coding agents

Usage:
  llmtally [options]

Options:
  --db <path>      Ledger database path (default: ~/.llmtally/ledger.db)
  --refresh <sec>  Auto-refresh interval to start with (min 30; remembered otherwise)
  --theme <name>   Color theme (p to pick; light themes paint a surface). mono = no color
  --chart <mode>   Chart style: block | braille | heatmap (g to pick; remembered)
  --help           Show this help

Tabs: [1] Overview  [2] Accounts  [3] Agents  [4] Models  [5] Search  [6] Doctor
Press ? inside the app for the full key list.

The first launch imports every local agent log it can find; later ones
collect incrementally. Requires an interactive terminal (TTY).
Exit codes: 0 success, 1 environment/fatal error, 2 usage error.`;

const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_USAGE = 2;
const MIN_REFRESH_SECONDS = 30;

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface AppOptions {
  readonly databasePath: string;
  /** null = start with auto-refresh off; undefined = use the saved choice. */
  readonly refreshSeconds: number | null | undefined;
  readonly themeName: string | null;
  /** null = use the remembered chart style. */
  readonly chartMode: ChartStyle | null;
  readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): AppOptions {
  let databasePath = defaultDatabasePath();
  let refreshSeconds: number | null | undefined;
  let themeName: string | null = null;
  let chartMode: ChartStyle | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    switch (flag) {
      case '--db': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('option "--db" requires a value');
        }
        databasePath = resolve(value);
        index += 1;
        break;
      }
      case '--refresh': {
        const value = Number(argv[index + 1]);
        if (!Number.isInteger(value) || value < MIN_REFRESH_SECONDS) {
          throw new UsageError(`--refresh must be an integer >= ${MIN_REFRESH_SECONDS} seconds`);
        }
        refreshSeconds = value;
        index += 1;
        break;
      }
      case '--theme': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('option "--theme" requires a value');
        }
        if (value !== 'mono' && findTheme(value) === null) {
          throw new UsageError(
            `unknown theme "${value}" (available: ${[...themeNames(), 'mono'].join(', ')})`,
          );
        }
        themeName = value;
        index += 1;
        break;
      }
      case '--chart': {
        const value = argv[index + 1];
        if (!isChartStyle(value)) {
          throw new UsageError(`--chart must be one of: ${CHART_STYLES.join(', ')}`);
        }
        chartMode = value;
        index += 1;
        break;
      }
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new UsageError(`unknown option "${flag}"`);
    }
  }
  return { databasePath, refreshSeconds, themeName, chartMode, help };
}

export async function run(argv: readonly string[]): Promise<number> {
  let options: AppOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`llmtally: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('llmtally: an interactive terminal (TTY) is required');
    return EXIT_FATAL;
  }

  let session: { stop: () => void } | null = null;
  const stopSignal = (): void => {
    session?.stop();
  };
  try {
    // NO_COLOR (or --theme mono) pins mono whatever the picker says
    const monoForced = process.env.NO_COLOR !== undefined || options.themeName === 'mono';
    const created = await createTuiSession({
      createScreen: (themeProvider: () => ResolvedTheme) => createOpentuiScreen(themeProvider),
      dataSource: createDefaultDataSource({ databasePath: options.databasePath }),
      chartMode: options.chartMode,
      themeName: options.themeName,
      refreshSeconds: options.refreshSeconds,
      monoForced,
      firstRun: isFirstRun(options.databasePath),
    });
    session = created;
    process.on('SIGINT', stopSignal);
    process.on('SIGTERM', stopSignal);
    await created.run();
    return EXIT_OK;
  } catch (error) {
    session?.stop();
    console.error(
      `llmtally: fatal error: ${sanitizeTerminalLine(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    return EXIT_FATAL;
  } finally {
    process.off('SIGINT', stopSignal);
    process.off('SIGTERM', stopSignal);
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
