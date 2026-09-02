import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { CursorCliAdapter } from '@llmtally/core/parsers/cursor-cli/adapter.ts';
import { UnknownAgentError, createDefaultCoordinator } from '@llmtally/core/scan/coordinator.ts';
import type { ScanBatch, StoredScanState } from '@llmtally/core/scan/types.ts';
import { makeTempDir } from '../../helpers.ts';

const PROJECT_DIR = '%2FUsers%2Fdev%2Fproj';
const SESSION_ID = 'sess-cursor-1';
const TS = '2026-08-17T01:00:00Z';

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: SESSION_ID,
    uuid: 'user-1',
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function resultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    session_id: SESSION_ID,
    request_id: 'req-1',
    timestamp: TS,
    model: 'grok-4.6',
    usage: {
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
    },
    ...overrides,
  });
}

function assistantUsage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: SESSION_ID,
    request_id: 'req-1',
    timestamp: TS,
    message: {
      model: 'grok-4.6',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...overrides,
      },
    },
  });
}

function writeTranscript(root: string, lines: readonly string[]): string {
  const dir = join(root, PROJECT_DIR, 'agent-transcripts', SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION_ID}.jsonl`);
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

async function scanAll(
  root: string,
  state: StoredScanState | null = null,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[]; paths: string[] }> {
  const adapter = new CursorCliAdapter({ rootDirectory: root });
  const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });
  const batches: ScanBatch[] = [];
  const entries: LedgerEntry[] = [];
  for (const target of discovery.targets) {
    for await (const batch of adapter.scan(target, state, {
      fullRescan: false,
      scanCeilingBytes: null,
    })) {
      batches.push(batch);
      entries.push(...batch.entries);
    }
  }
  return { entries, batches, paths: discovery.targets.map((target) => target.path) };
}

function stateFrom(path: string, batches: readonly ScanBatch[]): StoredScanState {
  const last = batches[batches.length - 1];
  if (last === undefined || last.nextOffset === null) {
    throw new Error('scan produced no committable batch');
  }
  return {
    agent: 'cursor-cli',
    path,
    mtime: last.sourceMtime ?? 0,
    size: last.sourceSize ?? 0,
    lastOffset: last.nextOffset,
    cursorJson: last.nextCursor,
  };
}

describe('CursorCliAdapter.discover', () => {
  test('keeps agent-transcripts jsonl and ignores sibling project files', async () => {
    const root = makeTempDir();
    const path = writeTranscript(root, [userLine('hi')]);
    writeFileSync(join(root, PROJECT_DIR, 'other.jsonl'), '{"type":"user"}\n');

    const { paths } = await scanAll(root);

    expect(paths).toEqual([path]);
  });
});

describe('CursorCliAdapter.scan', () => {
  test('joins a user prompt with result usage and does not invent cost', async () => {
    const root = makeTempDir();
    writeTranscript(root, [userLine('summarize the diff'), resultLine()]);

    const { entries } = await scanAll(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'cursor-cli',
      account: null,
      provider: 'cursor',
      model: 'grok-4.6',
      promptText: 'summarize the diff',
      inputTokens: 20,
      outputTokens: 5,
      cacheRead: 4,
      cacheWrite: 1,
      costUsd: null,
      sessionId: SESSION_ID,
      cwd: '/Users/dev/proj',
      naturalId: `${SESSION_ID}:req-1:grok-4.6`,
    });
  });

  test('a usage-less assistant produces no row and no warning', async () => {
    const root = makeTempDir();
    writeTranscript(root, [
      userLine('hi'),
      JSON.stringify({
        type: 'assistant',
        timestamp: TS,
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ]);

    const { entries, batches } = await scanAll(root);

    expect(entries).toHaveLength(0);
    expect(batches.flatMap((batch) => batch.warnings)).toHaveLength(0);
  });

  test('assistant + result usage for one request_id keeps the more complete row', async () => {
    const root = makeTempDir();
    writeTranscript(root, [userLine('hi'), assistantUsage(), resultLine()]);

    const { entries } = await scanAll(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.inputTokens).toBe(20);
    expect(entries[0]?.cacheRead).toBe(4);
  });

  test('resuming from the committed offset inserts nothing', async () => {
    const root = makeTempDir();
    const path = writeTranscript(root, [userLine('hi'), resultLine()]);
    const first = await scanAll(root);
    expect(first.entries).toHaveLength(1);

    const second = await scanAll(root, stateFrom(path, first.batches));

    expect(second.entries).toHaveLength(0);
  });

  test('a truncated tail stays unconsumed so the next scan can retry it', async () => {
    const root = makeTempDir();
    const dir = join(root, PROJECT_DIR, 'agent-transcripts', SESSION_ID);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(path, `${userLine('hi')}\n{"type":"result","usage":`);

    const { entries, batches } = await scanAll(root);
    const last = batches[batches.length - 1];

    expect(entries).toHaveLength(0);
    expect(last?.tailPending).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('createDefaultCoordinator', () => {
  test('registers cursor-cli among known agents', async () => {
    const databasePath = join(makeTempDir(), 'ledger.db');
    try {
      await createDefaultCoordinator().run({
        agent: '__nope__',
        fullRescan: false,
        databasePath,
      });
      throw new Error('expected UnknownAgentError');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownAgentError);
      expect((error as Error).message).toContain('cursor-cli');
    }
  });
});
