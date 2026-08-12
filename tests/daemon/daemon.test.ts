import { describe, expect, test } from 'bun:test';

import type { LaunchctlRunner } from '@llmtally/core/daemon/service.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { daemonPlistPath, renderDaemonPlist } from '@llmtally/core/daemon/plist.ts';
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

