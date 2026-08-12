/**
 * Install, remove, and inspect the launchd agent that collects usage
 * in the background. This is domain logic rather than presentation:
 * it returns what happened so the terminal app can render it and the
 * menubar app can reuse it unchanged.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { defaultDatabasePath } from '../config/paths.ts';
import {
  DAEMON_LABEL,
  DEFAULT_INTERVAL_SECONDS,
  daemonPlistPath,
  defaultLogDirectory,
  renderDaemonPlist,
  resolveExecutable,
} from './plist.ts';

export type LaunchctlRunner = (args: readonly string[]) => {
  readonly exitCode: number;
  readonly stderr: string;
};

/** Absolute path + timeout so a PATH-planted `launchctl` cannot run. */
const LAUNCHCTL_BIN = '/bin/launchctl';
const LAUNCHCTL_TIMEOUT_MS = 10_000;

export const defaultLaunchctl: LaunchctlRunner = (args) => {
  // launchctl is macOS-only; on other platforms report unavailable
  // rather than spawning a same-named binary from PATH
  if (process.platform !== 'darwin') {
    return { exitCode: 1, stderr: 'launchctl is only available on macOS' };
  }
  const result = Bun.spawnSync([LAUNCHCTL_BIN, ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: LAUNCHCTL_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
};

export interface DaemonOptions {
  readonly launchctl?: LaunchctlRunner;
  readonly home?: string;
  readonly ledgerPath?: string;
  readonly intervalSeconds?: number;
  /** A checkout can move; installing from one needs an explicit opt-in. */
  readonly allowDevCheckout?: boolean;
}

export interface DaemonResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface DaemonStatus {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly plistPath: string;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function installDaemon(options: DaemonOptions = {}): DaemonResult {
  const home = options.home ?? homedir();
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
    return { ok: false, message: 'interval must be an integer of at least 60 seconds' };
  }

  const executable = resolveExecutable();
  if (executable.isDevCheckout && options.allowDevCheckout !== true) {
    return {
      ok: false,
      message:
        'refusing to install from a development checkout — the daemon would break if the checkout moves',
    };
  }

  const logDirectory = defaultLogDirectory(home);
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const plist = renderDaemonPlist({
    bunPath: executable.bunPath,
    mainPath: executable.mainPath,
    ledgerPath: options.ledgerPath ?? defaultDatabasePath(home),
    logDirectory,
    intervalSeconds,
  });
  const path = daemonPlistPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, plist, { mode: 0o600 });
  renameSync(tempPath, path);
  chmodSync(path, 0o600);

  // reload cleanly when a previous agent is already bootstrapped
  launchctl(['bootout', `${domain()}/${DAEMON_LABEL}`]);
  const result = launchctl(['bootstrap', domain(), path]);
  if (result.exitCode !== 0) {
    return { ok: false, message: `launchctl bootstrap failed: ${result.stderr.trim()}` };
  }
  return { ok: true, message: `installed ${DAEMON_LABEL} (every ${intervalSeconds}s)` };
}

export function uninstallDaemon(options: DaemonOptions = {}): DaemonResult {
  const home = options.home ?? homedir();
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const path = daemonPlistPath(home);
  launchctl(['bootout', `${domain()}/${DAEMON_LABEL}`]);
  if (!existsSync(path)) {
    return { ok: true, message: `${DAEMON_LABEL} was not installed` };
  }
  unlinkSync(path);
  return { ok: true, message: `uninstalled ${DAEMON_LABEL}` };
}

export function daemonStatus(options: DaemonOptions = {}): DaemonStatus {
  const home = options.home ?? homedir();
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const plistPath = daemonPlistPath(home);
  return {
    installed: existsSync(plistPath),
    loaded: launchctl(['print', `${domain()}/${DAEMON_LABEL}`]).exitCode === 0,
    plistPath,
  };
}
