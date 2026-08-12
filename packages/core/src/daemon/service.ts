/**
 * Install, remove, and inspect the background collection agent. This is
 * domain logic rather than presentation: it returns what happened so
 * the terminal app can render it and the menubar app can reuse it
 * unchanged.
 *
 * The backend is picked per platform — launchd on macOS, a systemd
 * user timer on Linux — and an unsupported platform is refused BEFORE
 * anything is written: the old code created `~/Library/LaunchAgents`
 * on Linux and only then let launchctl fail (grok cross-platform
 * review P0, "부작용이 있는 거절").
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
import {
  SYSTEMD_UNIT_NAME,
  renderSystemdService,
  renderSystemdTimer,
  systemdServicePath,
  systemdTimerPath,
  systemdUnitDir,
} from './systemd.ts';
import type { ResolvedExecutable } from './plist.ts';

export type CommandRunner = (args: readonly string[]) => {
  readonly exitCode: number;
  readonly stderr: string;
};
export type LaunchctlRunner = CommandRunner;

/** Absolute paths + timeout so a PATH-planted binary cannot run. */
const LAUNCHCTL_BIN = '/bin/launchctl';
const SYSTEMCTL_BIN = '/usr/bin/systemctl';
const RUNNER_TIMEOUT_MS = 10_000;

function makeRunner(binary: string, platform: NodeJS.Platform): CommandRunner {
  return (args) => {
    if (process.platform !== platform) {
      return { exitCode: 1, stderr: `${binary} is not available on this platform` };
    }
    const result = Bun.spawnSync([binary, ...args], {
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: RUNNER_TIMEOUT_MS,
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString() };
  };
}

export const defaultLaunchctl: CommandRunner = makeRunner(LAUNCHCTL_BIN, 'darwin');
export const defaultSystemctl: CommandRunner = makeRunner(SYSTEMCTL_BIN, 'linux');

export interface DaemonOptions {
  readonly launchctl?: CommandRunner;
  readonly systemctl?: CommandRunner;
  readonly home?: string;
  readonly ledgerPath?: string;
  readonly intervalSeconds?: number;
  /** A checkout can move; installing from one needs an explicit opt-in. */
  readonly allowDevCheckout?: boolean;
  /** Test seam: which platform's backend to use. */
  readonly platform?: NodeJS.Platform;
  /** Test seam: overrides bun/worker path resolution. */
  readonly executable?: ResolvedExecutable;
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

function platformOf(options: DaemonOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

const UNSUPPORTED: DaemonResult = {
  ok: false,
  message:
    'background collection is available on macOS (launchd) and Linux (systemd user timer) — this platform has no backend yet',
};

/** Validates the interval and the executable; shared by both backends. */
function prepare(options: DaemonOptions): { executable: ResolvedExecutable } | DaemonResult {
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
    return { ok: false, message: 'interval must be an integer of at least 60 seconds' };
  }
  const executable = options.executable ?? resolveExecutable();
  if (executable.isDevCheckout && options.allowDevCheckout !== true) {
    return {
      ok: false,
      message:
        'refusing to install from a development checkout — the daemon would break if the checkout moves',
    };
  }
  if (!existsSync(executable.workerPath)) {
    // a unit pointing at a missing file would just crash-loop hourly
    return {
      ok: false,
      message: `scan worker not found at ${executable.workerPath} — reinstall llmtally`,
    };
  }
  return { executable };
}

export function installDaemon(options: DaemonOptions = {}): DaemonResult {
  const platform = platformOf(options);
  if (platform === 'darwin') {
    return installLaunchd(options);
  }
  if (platform === 'linux') {
    return installSystemd(options);
  }
  return UNSUPPORTED;
}

export function uninstallDaemon(options: DaemonOptions = {}): DaemonResult {
  const platform = platformOf(options);
  if (platform === 'darwin') {
    return uninstallLaunchd(options);
  }
  if (platform === 'linux') {
    return uninstallSystemd(options);
  }
  return UNSUPPORTED;
}

export function daemonStatus(options: DaemonOptions = {}): DaemonStatus {
  const platform = platformOf(options);
  const home = options.home ?? homedir();
  if (platform === 'linux') {
    const systemctl = options.systemctl ?? defaultSystemctl;
    return {
      installed: existsSync(systemdTimerPath(home)),
      loaded: systemctl(['--user', 'is-active', '--quiet', `${SYSTEMD_UNIT_NAME}.timer`]).exitCode === 0,
      plistPath: systemdTimerPath(home),
    };
  }
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const plistPath = daemonPlistPath(home);
  return {
    installed: existsSync(plistPath),
    loaded: launchctl(['print', `${domain()}/${DAEMON_LABEL}`]).exitCode === 0,
    plistPath,
  };
}

function installLaunchd(options: DaemonOptions): DaemonResult {
  const home = options.home ?? homedir();
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const prepared = prepare(options);
  if ('ok' in prepared) {
    return prepared;
  }

  const logDirectory = defaultLogDirectory(home);
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const plist = renderDaemonPlist({
    bunPath: prepared.executable.bunPath,
    workerPath: prepared.executable.workerPath,
    ledgerPath: options.ledgerPath ?? defaultDatabasePath(home),
    logDirectory,
    intervalSeconds,
  });
  const path = daemonPlistPath(home);
  writePrivate(path, plist);

  // reload cleanly when a previous agent is already bootstrapped
  launchctl(['bootout', `${domain()}/${DAEMON_LABEL}`]);
  const result = launchctl(['bootstrap', domain(), path]);
  if (result.exitCode !== 0) {
    return { ok: false, message: `launchctl bootstrap failed: ${result.stderr.trim()}` };
  }
  return { ok: true, message: `installed ${DAEMON_LABEL} (every ${intervalSeconds}s)` };
}

function uninstallLaunchd(options: DaemonOptions): DaemonResult {
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

function installSystemd(options: DaemonOptions): DaemonResult {
  const home = options.home ?? homedir();
  const systemctl = options.systemctl ?? defaultSystemctl;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const prepared = prepare(options);
  if ('ok' in prepared) {
    return prepared;
  }

  const logDirectory = defaultLogDirectory(home);
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const config = {
    bunPath: prepared.executable.bunPath,
    workerPath: prepared.executable.workerPath,
    ledgerPath: options.ledgerPath ?? defaultDatabasePath(home),
    logDirectory,
    intervalSeconds,
  };
  mkdirSync(systemdUnitDir(home), { recursive: true });
  writePrivate(systemdServicePath(home), renderSystemdService(config));
  writePrivate(systemdTimerPath(home), renderSystemdTimer(config));

  const reload = systemctl(['--user', 'daemon-reload']);
  if (reload.exitCode !== 0) {
    return { ok: false, message: `systemctl --user daemon-reload failed: ${reload.stderr.trim()}` };
  }
  const enable = systemctl(['--user', 'enable', '--now', `${SYSTEMD_UNIT_NAME}.timer`]);
  if (enable.exitCode !== 0) {
    return { ok: false, message: `systemctl --user enable failed: ${enable.stderr.trim()}` };
  }
  return { ok: true, message: `installed ${SYSTEMD_UNIT_NAME}.timer (every ${intervalSeconds}s)` };
}

function uninstallSystemd(options: DaemonOptions): DaemonResult {
  const home = options.home ?? homedir();
  const systemctl = options.systemctl ?? defaultSystemctl;
  const timerPath = systemdTimerPath(home);
  const servicePath = systemdServicePath(home);
  systemctl(['--user', 'disable', '--now', `${SYSTEMD_UNIT_NAME}.timer`]);
  if (!existsSync(timerPath) && !existsSync(servicePath)) {
    return { ok: true, message: `${SYSTEMD_UNIT_NAME} was not installed` };
  }
  if (existsSync(timerPath)) {
    unlinkSync(timerPath);
  }
  if (existsSync(servicePath)) {
    unlinkSync(servicePath);
  }
  systemctl(['--user', 'daemon-reload']);
  return { ok: true, message: `uninstalled ${SYSTEMD_UNIT_NAME}` };
}

/** Atomic 0600 write: temp in the same directory, then rename. */
function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, content, { mode: 0o600 });
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}
