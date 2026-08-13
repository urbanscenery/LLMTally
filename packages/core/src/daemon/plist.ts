import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DAEMON_LABEL = 'com.llmtally.scan';
export const DEFAULT_INTERVAL_SECONDS = 3600;

export interface DaemonConfig {
  readonly bunPath: string;
  /** The headless scan entry point (`scan-worker.ts`), not the TUI. */
  readonly workerPath: string;
  readonly ledgerPath: string;
  readonly logDirectory: string;
  readonly intervalSeconds: number;
}

export function daemonPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
}

export function defaultLogDirectory(home: string = homedir()): string {
  return join(home, '.llmtally', 'logs');
}

export interface ResolvedExecutable {
  readonly bunPath: string;
  /** `scan-worker.ts` next to the running TUI entry point. */
  readonly workerPath: string;
  readonly isDevCheckout: boolean;
}

/**
 * launchd gets no shell and no PATH, so both the Bun binary and the
 * entrypoint are pinned as realpath'd absolute paths. The daemon runs
 * the headless worker that lives next to the TUI entry point — the TUI
 * itself has no subcommands and needs a TTY. An entrypoint outside a
 * node_modules install is a development checkout — installing a daemon
 * against it silently breaks when the checkout moves.
 */
export function resolveExecutable(): ResolvedExecutable {
  const bunPath = realpathSync(process.execPath);
  const mainPath = realpathSync(Bun.main);
  return {
    bunPath,
    workerPath: join(dirname(mainPath), 'scan-worker.ts'),
    isDevCheckout: !mainPath.includes(`${join('node_modules', 'llmtally')}/`),
  };
}

export function renderDaemonPlist(config: DaemonConfig): string {
  const args = [config.bunPath, config.workerPath, '--db', config.ledgerPath]
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>Program</key>
  <string>${escapeXml(config.bunPath)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${config.intervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(config.logDirectory, 'scan.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(config.logDirectory, 'scan-error.log'))}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
