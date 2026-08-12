import { describe, expect, test } from 'bun:test';

import type { LaunchctlRunner } from '@llmtally/core/daemon/service.ts';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { daemonPlistPath, renderDaemonPlist } from '@llmtally/core/daemon/plist.ts';
import { installDaemon, uninstallDaemon } from '@llmtally/core/daemon/service.ts';
import { renderSystemdService, renderSystemdTimer } from '@llmtally/core/daemon/systemd.ts';
import { makeTempDir } from '../helpers.ts';

const okLaunchctl: LaunchctlRunner = () => ({ exitCode: 0, stderr: '' });

describe('renderDaemonPlist', () => {
  test('pins absolute paths, escapes xml, and never uses a shell', () => {
    // Act
    const plist = renderDaemonPlist({
      bunPath: '/opt/bun',
      workerPath: '/apps/<llm>&"tally"/scan-worker.ts',
      ledgerPath: '/data/ledger.db',
      logDirectory: '/logs',
      intervalSeconds: 1800,
    });

    // Assert
    expect(plist).toContain('<string>/opt/bun</string>');
    expect(plist).toContain('&lt;llm&gt;&amp;&quot;tally&quot;');
    expect(plist).toContain('<integer>1800</integer>');
    expect(plist).toContain('<string>--db</string>');
    expect(plist).not.toContain('sh -c');
    expect(plist).toContain('<key>Umask</key>');
    expect(plist).not.toContain('RunAtLoad');
  });

  test('the program arguments run the headless worker, not a TUI subcommand', () => {
    // llmtally has no subcommands: a plist that passed `scan` to the
    // TUI entry made the daemon exit 2 on every tick (audit R-03)
    const plist = renderDaemonPlist({
      bunPath: '/opt/bun',
      workerPath: '/install/packages/tui/src/scan-worker.ts',
      ledgerPath: '/data/ledger.db',
      logDirectory: '/logs',
      intervalSeconds: 3600,
    });

    expect(plist).toContain('<string>/install/packages/tui/src/scan-worker.ts</string>');
    expect(plist).not.toContain('<string>scan</string>');
    expect(plist).not.toContain('main.ts');
  });
});


describe('systemd backend (Linux)', () => {
  const executable = {
    bunPath: '/opt/bun',
    workerPath: '/install/packages/tui/src/scan-worker.ts',
    isDevCheckout: false,
  };

  function fakeSystemctl(calls: string[][]): LaunchctlRunner {
    return (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: '' };
    };
  }

  test('renders quoted absolute paths and a persistent hourly timer', () => {
    // Act
    const service = renderSystemdService({
      bunPath: '/opt/bun',
      workerPath: '/apps/my "tally"/scan-worker.ts',
      ledgerPath: '/data/ledger.db',
      logDirectory: '/logs',
      intervalSeconds: 3600,
    });
    const timer = renderSystemdTimer({
      bunPath: '/opt/bun',
      workerPath: '/x',
      ledgerPath: '/x',
      logDirectory: '/x',
      intervalSeconds: 1800,
    });

    // Assert — no shell, quoted args, catch-up after sleep
    expect(service).toContain('ExecStart="/opt/bun" "/apps/my \\"tally\\"/scan-worker.ts" "--db" "/data/ledger.db"');
    expect(service).toContain('UMask=0077');
    expect(timer).toContain('OnUnitActiveSec=1800');
    expect(timer).toContain('Persistent=true');
  });

  test('install writes both units 0600 and enables the timer', () => {
    // Arrange
    const home = makeTempDir();
    const calls: string[][] = [];
    const fakeWorkerDir = makeTempDir();
    const worker = join(fakeWorkerDir, 'scan-worker.ts');
    writeFileSync(worker, '// worker');

    // Act
    const result = installDaemon({
      platform: 'linux',
      home,
      systemctl: fakeSystemctl(calls),
      executable: { ...executable, workerPath: worker },
      ledgerPath: '/data/ledger.db',
    });

    // Assert
    expect(result.ok).toBe(true);
    const servicePath = join(home, '.config', 'systemd', 'user', 'llmtally-scan.service');
    const timerPath = join(home, '.config', 'systemd', 'user', 'llmtally-scan.timer');
    expect(readFileSync(servicePath, 'utf8')).toContain(worker);
    expect(statSync(timerPath).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', 'llmtally-scan.timer'],
    ]);

    // Act — uninstall removes both and reloads
    const removed = uninstallDaemon({ platform: 'linux', home, systemctl: fakeSystemctl(calls) });

    // Assert
    expect(removed.ok).toBe(true);
    expect(existsSync(servicePath)).toBe(false);
    expect(existsSync(timerPath)).toBe(false);
  });

  test('an unsupported platform is refused before anything is written', () => {
    // Arrange — the old code created ~/Library on Linux before failing
    const home = makeTempDir();

    // Act
    const result = installDaemon({ platform: 'win32', home });

    // Assert — refusal with zero side effects
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no backend');
    expect(existsSync(join(home, 'Library'))).toBe(false);
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.llmtally'))).toBe(false);
  });
});
