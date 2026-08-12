/**
 * systemd user-unit backend for background collection on Linux — the
 * launchd counterpart (grok cross-platform review P2). A service unit
 * runs the same headless scan worker the plist runs, and a timer fires
 * it hourly with `Persistent=true` so a machine that slept through a
 * tick catches up (the Claude 30-day log deletion window makes missed
 * ticks expensive).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SYSTEMD_UNIT_NAME = 'llmtally-scan';

export interface SystemdConfig {
  readonly bunPath: string;
  readonly workerPath: string;
  readonly ledgerPath: string;
  readonly logDirectory: string;
  readonly intervalSeconds: number;
}

export function systemdUnitDir(home: string = homedir()): string {
  return join(home, '.config', 'systemd', 'user');
}

export function systemdServicePath(home: string = homedir()): string {
  return join(systemdUnitDir(home), `${SYSTEMD_UNIT_NAME}.service`);
}

export function systemdTimerPath(home: string = homedir()): string {
  return join(systemdUnitDir(home), `${SYSTEMD_UNIT_NAME}.timer`);
}

/**
 * systemd's ExecStart quoting: double quotes with backslash escapes.
 * Paths are pinned absolute for the same reason the plist pins them —
 * a user unit gets no shell and an unpredictable PATH.
 */
function quoteExecArg(argument: string): string {
  return `"${argument.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderSystemdService(config: SystemdConfig): string {
  const command = [config.bunPath, config.workerPath, '--db', config.ledgerPath]
    .map(quoteExecArg)
    .join(' ');
  return `[Unit]
Description=LLMTally usage collection

[Service]
Type=oneshot
ExecStart=${command}
UMask=0077
StandardOutput=append:${join(config.logDirectory, 'scan.log')}
StandardError=append:${join(config.logDirectory, 'scan-error.log')}
`;
}

export function renderSystemdTimer(config: SystemdConfig): string {
  return `[Unit]
Description=LLMTally hourly usage collection

[Timer]
OnBootSec=300
OnUnitActiveSec=${config.intervalSeconds}
Persistent=true

[Install]
WantedBy=timers.target
`;
}
