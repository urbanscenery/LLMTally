import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { AntigravityCliAdapter } from '@llmtally/core/parsers/antigravity/adapter.ts';
import { decodeMessage, firstVarint } from '@llmtally/core/parsers/antigravity/proto.ts';
import { parseGenMetadataBlob } from '@llmtally/core/parsers/antigravity/records.ts';
import type { ScanBatch, StoredScanState } from '@llmtally/core/scan/types.ts';
import { makeTempDir } from '../../helpers.ts';

// --- minimal protobuf writer for fixtures ---
function varint(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (remaining > 0);
  return out;
}
function field(fieldNumber: number, wireType: number): number[] {
  return varint(fieldNumber * 8 + wireType);
}
function varintField(fieldNumber: number, value: number): number[] {
  return [...field(fieldNumber, 0), ...varint(value)];
}
function bytesField(fieldNumber: number, payload: number[] | Uint8Array): number[] {
  const body = [...payload];
  return [...field(fieldNumber, 2), ...varint(body.length), ...body];
}
function stringField(fieldNumber: number, value: string): number[] {
  return bytesField(fieldNumber, [...new TextEncoder().encode(value)]);
}

interface UsageSpec {
  readonly fixedInput: number;
  readonly newInput: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total?: number;
  readonly responseId?: string | null;
  readonly model?: string;
  readonly tsUtc?: number;
}

function genBlob(spec: UsageSpec): Uint8Array {
  const usage = [
    ...varintField(1, spec.fixedInput),
    ...varintField(2, spec.newInput),
    ...varintField(3, spec.total ?? spec.output + spec.reasoning),
    ...varintField(5, spec.cacheRead),
    ...varintField(9, spec.output),
    ...varintField(10, spec.reasoning),
    ...(spec.responseId === null ? [] : stringField(11, spec.responseId ?? 'resp-1')),
  ];
  const timestamp = bytesField(9, bytesField(4, varintField(1, spec.tsUtc ?? 1_784_905_354)));
  const generation = [
    ...bytesField(4, usage),
    ...timestamp,
    ...stringField(19, spec.model ?? 'gemini-3.6-flash'),
  ];
  return new Uint8Array(bytesField(1, generation));
}

function createConversationDb(root: string, name: string, blobs: readonly Uint8Array[]): string {
  const path = join(root, `${name}.db`);
  const db = new Database(path, { create: true, strict: true });
  db.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);`);
  db.run('INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)', [`traj-${name}`, `casc-${name}`]);
  blobs.forEach((blob, index) => {
    db.run('INSERT INTO gen_metadata VALUES (?, ?, ?)', [index, blob, blob.byteLength]);
  });
  db.close();
  return path;
}

async function scanAll(
  root: string,
  state: StoredScanState | null = null,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[] }> {
  const adapter = new AntigravityCliAdapter({ rootDirectory: root });
  const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });
  const entries: LedgerEntry[] = [];
  const batches: ScanBatch[] = [];
  for (const target of discovery.targets) {
    for await (const batch of adapter.scan(target, state, { fullRescan: false, scanCeilingBytes: null })) {
      batches.push(batch);
      entries.push(...batch.entries);
    }
  }
  return { entries, batches };
}

describe('protobuf reader', () => {
  test('round-trips varints and rejects truncated messages', () => {
    // Act
    const decoded = decodeMessage(new Uint8Array(varintField(3, 1071)));

    // Assert
    expect(decoded !== null && firstVarint(decoded, 3)).toBe(1071);
    expect(decodeMessage(new Uint8Array([0x0a, 0xff]))).toBeNull();
  });
});

describe('parseGenMetadataBlob', () => {
  test('extracts the pinned field map', () => {
    // Act
    const parsed = parseGenMetadataBlob(
      genBlob({ fixedInput: 1071, newInput: 30402, cacheRead: 100, output: 518, reasoning: 49 }),
    );

    // Assert
    expect(parsed).toEqual({
      kind: 'usage',
      model: 'gemini-3.6-flash',
      tsUtc: 1_784_905_354,
      responseId: 'resp-1',
      inputTokens: 31_473,
      cacheRead: 100,
      outputTokens: 518,
      reasoningTokens: 49,
    });
  });

  test('fails closed when the output invariant breaks (schema drift guard)', () => {
    // Act
    const parsed = parseGenMetadataBlob(
      genBlob({ fixedInput: 1, newInput: 1, cacheRead: 0, output: 10, reasoning: 5, total: 99 }),
    );

    // Assert
    expect(parsed).toMatchObject({ kind: 'invalid' });
  });

  test('zero usage rows are skipped silently', () => {
    // Act & Assert
    expect(
      parseGenMetadataBlob(
        genBlob({ fixedInput: 0, newInput: 0, cacheRead: 0, output: 0, reasoning: 0 }),
      ),
    ).toEqual({ kind: 'skipped' });
  });
});

describe('AntigravityCliAdapter', () => {
  test('collects generations with separate reasoning tokens and response-id keys', async () => {
    // Arrange
    const root = makeTempDir();
    createConversationDb(root, 'conv1', [
      genBlob({ fixedInput: 1071, newInput: 30402, cacheRead: 0, output: 518, reasoning: 49, responseId: 'r1' }),
      genBlob({ fixedInput: 1071, newInput: 100, cacheRead: 28614, output: 16, reasoning: 52, responseId: 'r2' }),
    ]);

    // Act
    const { entries } = await scanAll(root);

    // Assert
    expect(entries.map((entry) => entry.naturalId)).toEqual([
      'traj-conv1:response:r1',
      'traj-conv1:response:r2',
    ]);
    expect(entries[0]).toMatchObject({
      agent: 'antigravity-cli',
      provider: 'google',
      model: 'gemini-3.6-flash',
      inputTokens: 31_473,
      outputTokens: 518,
      reasoningTokens: 49,
      cacheWrite: 0,
      costUsd: null,
      promptText: null,
      sessionId: 'casc-conv1',
      tsUtc: 1_784_905_354,
    });
  });

  test('an unchanged database is skipped via the wal-aware fingerprint', async () => {
    // Arrange
    const root = makeTempDir();
    const path = createConversationDb(root, 'conv1', [
      genBlob({ fixedInput: 1, newInput: 2, cacheRead: 0, output: 3, reasoning: 0, responseId: 'r1' }),
    ]);
    const first = await scanAll(root);
    const last = first.batches[first.batches.length - 1];
    const state: StoredScanState = {
      agent: 'antigravity-cli',
      path,
      mtime: last?.sourceMtime ?? 0,
      size: last?.sourceSize ?? 0,
      lastOffset: 0,
      cursorJson: last?.nextCursor ?? {},
    };

    // Act
    const second = await scanAll(root, state);

    // Assert
    expect(second.entries).toHaveLength(0);
    expect(second.batches[0]?.nextOffset).toBe(0);
  });

  test('undecodable blobs warn without stopping the healthy rows', async () => {
    // Arrange
    const root = makeTempDir();
    const good = genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 1, responseId: 'ok' });
    createConversationDb(root, 'conv1', [new Uint8Array([0xde, 0xad, 0xbe]), good]);

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert
    expect(entries).toHaveLength(1);
    expect(batches.flatMap((batch) => batch.warnings.map((warning) => warning.code))).toContain(
      'invalid_record',
    );
  });

  test('duplicate or missing response ids fall back to idx keys with a warning', async () => {
    // Arrange
    const root = makeTempDir();
    createConversationDb(root, 'conv1', [
      genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 0, responseId: 'dup' }),
      genBlob({ fixedInput: 1, newInput: 6, cacheRead: 0, output: 3, reasoning: 0, responseId: 'dup' }),
      genBlob({ fixedInput: 1, newInput: 7, cacheRead: 0, output: 4, reasoning: 0, responseId: null }),
    ]);

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert — the duplicate response is SKIPPED (double counting would
    // inflate usage); only the genuinely id-less row uses the idx fallback
    expect(entries.map((entry) => entry.naturalId)).toEqual([
      'traj-conv1:response:dup',
      'traj-conv1:idx:2',
    ]);
    expect(batches.flatMap((batch) => batch.warnings.map((warning) => warning.code))).toContain(
      'natural_id_collision',
    );
  });

  test('a usage field with an oversized varint fails closed instead of reading 0', async () => {
    // Arrange — field #2 (new input) encoded as a >2^53 varint
    const root = makeTempDir();
    const oversized = [
      ...bytesField(1, [
        ...bytesField(4, [
          ...varintField(1, 10),
          ...field(2, 0), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
          ...varintField(9, 5),
          ...varintField(10, 0),
          ...stringField(11, 'r-big'),
        ]),
        ...bytesField(9, bytesField(4, varintField(1, 1_784_905_354))),
        ...stringField(19, 'gemini-3.6-flash'),
      ]),
    ];
    createConversationDb(root, 'conv1', [new Uint8Array(oversized)]);

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert
    expect(entries).toHaveLength(0);
    expect(batches.flatMap((batch) => batch.warnings.map((warning) => warning.code))).toContain(
      'invalid_record',
    );
  });

  test('a missing conversations root is a recoverable discovery warning', async () => {
    // Act
    const adapter = new AntigravityCliAdapter({ rootDirectory: join(makeTempDir(), 'none') });
    const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });

    // Assert
    expect(discovery.targets).toHaveLength(0);
    expect(discovery.warnings[0]?.code).toBe('source_missing');
  });
});
