import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { compactLedger, ledgerSpaceReport } from '@llmtally/core/db/maintenance.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { acquireScanLock } from '@llmtally/core/scan/lock.ts';
import { makeTempDir } from '../helpers.ts';

const NOW = 1_786_400_000;

/** A ledger with enough deleted bulk that pages land on the freelist. */
function seededLedger(): string {
  const path = join(makeTempDir(), 'ledger.db');
  const db = new Database(path, { strict: true });
  migrate(db);
  const insert = db.prepare(
    `INSERT INTO usage_ledger
      (ts_utc, agent, model, prompt_text, input_tokens, output_tokens, natural_id, parser_version)
     VALUES (?, 'claude-code', 'fable', ?, 10, 5, ?, 1)`,
  );
  const filler = 'x'.repeat(4000);
  db.exec('BEGIN;');
  for (let row = 0; row < 2000; row += 1) {
    insert.run(NOW + row, `${filler}-${row}`, `nat-${row}`);
  }
  db.exec('COMMIT;');
  db.run('DELETE FROM usage_ledger WHERE ts_utc < ?', [NOW + 1900]);
  db.close();
  return path;
}

describe('ledgerSpaceReport', () => {
  test('reports null for a missing ledger and freed pages for a real one', () => {
    // Assert — no ledger yet
    expect(ledgerSpaceReport(join(makeTempDir(), 'ledger.db'))).toBeNull();

    // Arrange — bulk delete leaves pages on the freelist
    const path = seededLedger();

    // Act
    const report = ledgerSpaceReport(path);

    // Assert — SQLite reuses those pages but never returns them
    expect(report).not.toBeNull();
    expect(report?.fileBytes).toBeGreaterThan(0);
    expect(report?.reclaimableBytes).toBeGreaterThan(0);
  });
});

describe('compactLedger', () => {
  test('VACUUM returns the freed space and the data survives', () => {
    // Arrange
    const path = seededLedger();
    const before = statSync(path).size;

    // Act
    const result = compactLedger(path);

    // Assert — smaller file, empty freelist, rows intact
    expect(result.beforeBytes).toBe(before);
    expect(result.afterBytes).toBeLessThan(before);
    expect(result.reclaimedBytes).toBe(before - result.afterBytes);
    expect(ledgerSpaceReport(path)?.reclaimableBytes).toBe(0);
    const db = new Database(path, { readonly: true });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage_ledger').get()?.n).toBe(100);
    db.close();
  });

  test('refuses to run while a scan holds the lock', () => {
    // Arrange — compaction must never interleave with collection
    const path = seededLedger();
    const lock = acquireScanLock(`${path}.lock`);

    // Act & Assert
    try {
      expect(() => compactLedger(path)).toThrow(/holds the lock/);
    } finally {
      lock.release();
    }
    expect(compactLedger(path).afterBytes).toBeGreaterThan(0);
  });
});
