import { describe, expect, test } from 'bun:test';

import { USAGE, UsageError, parseArgs, run } from '@llmtally/tui/main.ts';

describe('parseArgs', () => {
  test('defaults: remembered auto-refresh, default db, no help', () => {
    // Act
    const options = parseArgs([]);

    // Assert
    expect(options.refreshSeconds).toBeUndefined();
    expect(options.help).toBe(false);
    expect(options.databasePath.length).toBeGreaterThan(0);
  });

  test('accepts --db and resolves it to an absolute path', () => {
    // Act
    const options = parseArgs(['--db', 'relative/ledger.db']);

    // Assert
    expect(options.databasePath.startsWith('/')).toBe(true);
    expect(options.databasePath.endsWith('relative/ledger.db')).toBe(true);
  });

  test('rejects a refresh interval below the minimum', () => {
    // Act & Assert
    expect(() => parseArgs(['--refresh', '5'])).toThrow(UsageError);
  });

  test('rejects unknown options', () => {
    // Act & Assert
    expect(() => parseArgs(['--bogus'])).toThrow(UsageError);
  });

  test('--chart accepts every style and defers to the remembered one', () => {
    // Act & Assert — null means "use the saved preference"
    expect(parseArgs([]).chartMode).toBeNull();
    for (const style of ['block', 'braille', 'heatmap'] as const) {
      expect(parseArgs(['--chart', style]).chartMode).toBe(style);
    }
    expect(() => parseArgs(['--chart', 'line'])).toThrow(UsageError);
    expect(() => parseArgs(['--chart', 'pie'])).toThrow(UsageError);
  });
});

describe('run', () => {
  test('prints usage with --help', async () => {
    // Act & Assert
    expect(await run(['--help'])).toBe(0);
  });

  test('fails fast without a TTY instead of hanging', async () => {
    // bun test runs without a TTY, so the command must refuse to start
    if (process.stdout.isTTY && process.stdin.isTTY) {
      return;
    }

    // Act & Assert
    expect(await run([])).toBe(1);
  });

  test('returns usage exit code for bad arguments', async () => {
    // Act & Assert
    expect(await run(['--refresh', 'abc'])).toBe(2);
  });
});
