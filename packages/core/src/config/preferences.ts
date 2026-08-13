/**
 * Remembered UI choices (theme, auto-refresh interval). They share
 * `~/.llmtally/config.json` with the pricing overrides, so writing them
 * is a read-modify-write that preserves every key it does not own — a
 * blind overwrite here would silently drop a user's model aliases.
 *
 * Preferences are a convenience, never a requirement: an unreadable or
 * malformed file yields empty preferences and a failed save is reported
 * to the caller rather than thrown at the user mid-render.
 */
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { writeFilePrivate } from '../fs/atomic.ts';
import { asObject, asString } from '../parsers/shared.ts';

const CONFIG_VERSION = 1;
const DIRECTORY_MODE = 0o700;

export interface UiPreferences {
  /** Theme name, or null when the user has never chosen one. */
  readonly theme: string | null;
  /** Auto-refresh seconds; null means off, undefined means never set. */
  readonly autoRefreshSeconds: number | null | undefined;
}

export const EMPTY_PREFERENCES: UiPreferences = { theme: null, autoRefreshSeconds: undefined };

export function defaultPreferencesPath(home: string = homedir()): string {
  return join(home, '.llmtally', 'config.json');
}

function readConfig(path: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Missing file → empty base; present-but-corrupt → throws. */
function readConfigForWrite(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  // a corrupt config must not be silently replaced by a version+ui
  // skeleton — that destroys pricing/privacy settings (audit CX-20)
  const parsed = asObject(JSON.parse(text));
  if (parsed === null) {
    throw new Error('config.json is not an object');
  }
  return parsed;
}

export function loadUiPreferences(path: string = defaultPreferencesPath()): UiPreferences {
  const root = readConfig(path);
  const ui = root === null ? null : asObject(root.ui);
  if (ui === null) {
    return EMPTY_PREFERENCES;
  }
  const seconds = ui.autoRefreshSeconds;
  return {
    theme: asString(ui.theme),
    autoRefreshSeconds:
      seconds === null
        ? null
        : typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
          ? Math.floor(seconds)
          : undefined,
  };
}

/**
 * Merges the given fields into the `ui` section. Returns an error
 * message instead of throwing so a failed save can surface as a footer
 * warning without interrupting the session.
 */
export function saveUiPreferences(
  patch: Partial<UiPreferences>,
  path: string = defaultPreferencesPath(),
): string | null {
  try {
    // every other key is preserved verbatim, whatever the version says:
    // a hand-written pricing override must not disappear because the
    // user picked a theme, and stamping the version we understand is
    // what makes the file readable again afterwards
    const base = readConfigForWrite(path);
    const ui = { ...(asObject(base.ui) ?? {}) };
    if ('theme' in patch) {
      ui.theme = patch.theme;
    }
    if ('autoRefreshSeconds' in patch) {
      ui.autoRefreshSeconds = patch.autoRefreshSeconds ?? null;
    }
    mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    writeFilePrivate(path, `${JSON.stringify({ ...base, version: CONFIG_VERSION, ui }, null, 2)}\n`);
    return null;
  } catch (error) {
    return `could not save preferences: ${error instanceof Error ? error.message : String(error)}`;
  }
}
