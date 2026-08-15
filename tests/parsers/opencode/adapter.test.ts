import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { OpenCodeAdapter } from '@llmtally/core/parsers/opencode/adapter.ts';
import type { ScanBatch, SourceTarget, StoredScanState } from '@llmtally/core/scan/types.ts';
import { makeTempDir } from '../../helpers.ts';
import { applyOpenCodeSql, createOpenCodeFixtureDb } from '../../opencode-fixture.ts';

function targetFor(path: string): SourceTarget {
  return { agent: 'opencode', path, kind: 'sqlite', fingerprint: null };
}

async function scanAll(
  path: string,
  state: StoredScanState | null = null,
  fullRescan = false,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[] }> {
  const adapter = new OpenCodeAdapter();
  const batches: ScanBatch[] = [];
  const entries: LedgerEntry[] = [];
  for await (const batch of adapter.scan(targetFor(path), state, {
    fullRescan,
    scanCeilingBytes: null,
  })) {
    batches.push(batch);
    entries.push(...batch.entries);
  }
  return { entries, batches };
}

function stateFromLastBatch(path: string, batches: readonly ScanBatch[]): StoredScanState {
  const last = batches[batches.length - 1];
  if (last === undefined || last.nextOffset === null) {
    throw new Error('scan produced no committable batch');
  }
  return {
    agent: 'opencode',
    path,
    mtime: last.sourceMtime ?? 0,
    size: last.sourceSize ?? 0,
    lastOffset: last.nextOffset,
    cursorJson: last.nextCursor,
  };
}

describe('OpenCodeAdapter.scan', () => {
  test('collects completed assistants with joined prompts and authoritative cost', async () => {
    // Arrange
    const path = createOpenCodeFixtureDb('seed.sql');

    // Act
    const { entries } = await scanAll(path);

    // Assert — the incomplete asst-3 is excluded, both boundary rows collected
    expect(entries.map((entry) => entry.naturalId)).toEqual(['asst-1', 'asst-2']);
    expect(entries[0]).toMatchObject({
      agent: 'opencode',
      provider: 'opencode-go',
      model: 'gpt-5.6-luna',
      effort: 'max',
      promptText: 'first part\nsecond part',
      // the parentID user message is the prompt identity shared by every step
      promptKey: 'user-1',
      inputTokens: 3,
      outputTokens: 119,
      reasoningTokens: 64,
      cacheWrite: 2137,
      cacheRead: 145270,
      costUsd: 0.5,
      sessionId: 'ses-1',
      cwd: '/tmp/oc',
      tsUtc: 900,
      parentUuid: 'user-1',
      isSidechain: false,
    });
    expect(entries[1]?.costUsd).toBe(0.125);
  });

  test('an assistant completed after the first scan is picked up incrementally', async () => {
    // Arrange
    const path = createOpenCodeFixtureDb('seed.sql');
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);
    applyOpenCodeSql(path, 'complete-assistant.sql');

    // Act
    const second = await scanAll(path, state);

    // Assert — the late completion moved time_updated past the watermark;
    // boundary rows are re-read by design and dedupe in the ledger
    expect(second.entries.map((entry) => entry.naturalId)).toEqual(['asst-1', 'asst-2', 'asst-3']);
    expect(second.entries[2]?.costUsd).toBe(0.05);
  });

  test('boundary rows at the exact watermark are re-read for natural-id dedup', async () => {
    // Arrange
    const path = createOpenCodeFixtureDb('seed.sql');
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);

    // Act — nothing changed; inclusive >= re-reads the boundary rows
    const second = await scanAll(path, state);

    // Assert
    expect(second.entries.map((entry) => entry.naturalId)).toEqual(['asst-1', 'asst-2']);
  });

  test('resets the watermark when the source database file was replaced', async () => {
    // Arrange
    const path = createOpenCodeFixtureDb('seed.sql');
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(path);
    applyOpenCodeSql(path, 'schema.sql', 'seed.sql');

    // Act — new inode, cursor identity mismatch → full re-read
    const second = await scanAll(path, state);
    const codes = second.batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(codes).toContain('cursor_reset');
    expect(second.entries.map((entry) => entry.naturalId)).toEqual(['asst-1', 'asst-2']);
  });

  test('resets the watermark when the database was restored in place to an older state', async () => {
    // Arrange — same file identity but a watermark above MAX(time_updated)
    const path = createOpenCodeFixtureDb('seed.sql');
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);
    const inflated = {
      ...state,
      cursorJson: { ...state.cursorJson, updatedMs: 999_999 },
    };

    // Act
    const second = await scanAll(path, inflated);
    const codes = second.batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(codes).toContain('cursor_reset');
    expect(second.entries.map((entry) => entry.naturalId)).toEqual(['asst-1', 'asst-2']);
  });

  test('isolates malformed message and part json as warnings', async () => {
    // Arrange
    const path = createOpenCodeFixtureDb('seed.sql', 'malformed.sql');

    // Act
    const { entries, batches } = await scanAll(path);
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert — valid rows keep flowing, prompts keep their valid parts
    expect(entries.map((entry) => entry.naturalId)).toEqual(['asst-1', 'asst-2']);
    expect(entries[0]?.promptText).toBe('first part\nsecond part');
    expect(codes).toContain('invalid_record');
    expect(codes).toContain('malformed_json');
  });

  test('reports an unsupported schema without advancing the cursor', async () => {
    // Arrange
    const path = join(makeTempDir(), 'opencode.db');
    applyOpenCodeSql(path, 'schema-missing.sql');

    // Act
    const { batches } = await scanAll(path);

    // Assert
    expect(batches).toHaveLength(1);
    expect(batches[0]?.nextOffset).toBeNull();
    expect(batches[0]?.warnings[0]?.message).toContain('unsupported source schema');
  });

  test('discover reports a missing database as a recoverable warning', async () => {
    // Arrange
    const adapter = new OpenCodeAdapter({ databasePath: join(makeTempDir(), 'none.db') });

    // Act
    const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });

    // Assert
    expect(discovery.targets).toHaveLength(0);
    expect(discovery.warnings[0]?.code).toBe('source_missing');
  });

  test('discover returns the sqlite target when the database exists', async () => {
    // Arrange
    const path = createOpenCodeFixtureDb('seed.sql');
    const adapter = new OpenCodeAdapter({ databasePath: path });

    // Act
    const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });

    // Assert
    expect(discovery.targets).toEqual([
      { agent: 'opencode', path, kind: 'sqlite', fingerprint: null },
    ]);
  });
});

describe('windowed collection (D-04)', () => {
  test('a history larger than one window is ingested completely, window by window', async () => {
    // Arrange — 4,100 completed assistants: more than two 2,000-message
    // windows, with a run of identical timestamps crossing a boundary
    const path = createOpenCodeFixtureDb();
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { strict: true });
    const insert = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN;');
    insert.run('user-1', 'ses-1', 100, 100, '{"role":"user","time":{"created":100}}');
    for (let index = 0; index < 4100; index += 1) {
      // ids sort lexicographically in insertion order; a plateau of
      // equal time_updated values spans the first window boundary
      const timeUpdated = index < 2100 ? 1000 : 1000 + index;
      insert.run(
        `asst-${String(index).padStart(5, '0')}`,
        'ses-1',
        500,
        timeUpdated,
        `{"role":"assistant","tokens":{"input":1,"output":2},"modelID":"m","providerID":"opencode-go","time":{"created":500,"completed":900000},"parentID":"user-1"}`,
      );
    }
    db.exec('COMMIT;');
    db.close();

    // Act
    const { entries, batches } = await scanAll(path);

    // Assert — nothing lost or doubled across window boundaries
    expect(entries).toHaveLength(4100);
    const seen = new Set(entries.map((entry) => entry.naturalId));
    expect(seen.size).toBe(4100);
    expect(batches.length).toBeGreaterThan(2);
    // a resume from the final cursor may re-read the boundary
    // millisecond (`>=` semantics; the ledger natural key absorbs it)
    // but must never surface a row the first pass missed
    const resumed = await scanAll(path, stateFromLastBatch(path, batches));
    expect(resumed.entries.length).toBeLessThanOrEqual(1);
    expect(resumed.entries.every((entry) => seen.has(entry.naturalId))).toBe(true);
  });
});
