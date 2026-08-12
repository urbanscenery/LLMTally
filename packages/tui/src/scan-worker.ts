#!/usr/bin/env bun
/**
 * Headless incremental scan, the entry point the launchd agent runs.
 *
 * This is deliberately NOT a subcommand: `llmtally` stays a TUI with no
 * CLI surface (decided 2026-08-11), so background collection gets its
 * own file that the plist points at directly. It must never require a
 * TTY, never prompt, and say what it did in one line — launchd captures
 * stdout/stderr into `~/.llmtally/logs/`.
 *
 * Exit codes: 0 scanned, 1 scan failed, 2 usage error.
 */
import { resolve } from 'node:path';

import { defaultDatabasePath } from '@llmtally/core/config/paths.ts';
import { createDefaultCoordinator } from '@llmtally/core/scan/coordinator.ts';
import type { ScanCoordinator } from '@llmtally/core/scan/types.ts';

export async function runScanWorker(
  argv: readonly string[],
  coordinator?: ScanCoordinator,
): Promise<number> {
  let databasePath = defaultDatabasePath();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--db') {
      const value = argv[index + 1];
      if (value === undefined) {
        console.error('scan-worker: --db requires a path');
        return 2;
      }
      databasePath = resolve(value);
      index += 1;
      continue;
    }
    console.error(`scan-worker: unknown argument "${argument}"`);
    return 2;
  }

  try {
    const summary = await (coordinator ?? createDefaultCoordinator()).run({
      agent: null,
      fullRescan: false,
      databasePath,
    });
    console.log(
      `scanned ${summary.scannedFiles}/${summary.discoveredFiles} files, ` +
        `+${summary.insertedRows} rows, ${summary.warningTotal} warning(s) — ${databasePath}`,
    );
    return 0;
  } catch (error) {
    console.error(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runScanWorker(process.argv.slice(2));
}
