import { describe, expect, test } from 'bun:test';
import { appendFileSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { ClaudeCodeAdapter } from '@llmtally/core/parsers/claude-code/adapter.ts';
import { fingerprintFile } from '@llmtally/core/scan/file-discovery.ts';
import type { ScanBatch, SourceTarget, StoredScanState } from '@llmtally/core/scan/types.ts';
import { fixturePath, makeTempDir } from '../helpers.ts';

function targetFor(path: string): SourceTarget {
  const stats = statSync(path);
  return {
    agent: 'claude-code',
    path,
    kind: 'jsonl',
    fingerprint: fingerprintFile(path, stats.size, stats.dev, stats.ino),
  };
}

async function scanAll(
  path: string,
  state: StoredScanState | null = null,
  fullRescan = false,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[] }> {
  const adapter = new ClaudeCodeAdapter();
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
    agent: 'claude-code',
    path,
    mtime: last.sourceMtime ?? 0,
    size: last.sourceSize ?? 0,
    lastOffset: last.nextOffset,
    cursorJson: last.nextCursor,
  };
}

describe('ClaudeCodeAdapter.scan', () => {
  test('parses the basic fixture into correlated usage entries', async () => {
    // Act
    const { entries } = await scanAll(fixturePath('claude-code', 'basic.jsonl'));

    // Assert
    expect(entries.map((entry) => entry.naturalId)).toEqual(['a1', 'a2', 'a3']);
    expect(entries[0]).toMatchObject({
      agent: 'claude-code',
      provider: 'anthropic',
      model: 'claude-fable-5',
      effort: 'high',
      promptText: 'How do I parse JSONL fast?',
      inputTokens: 12,
      outputTokens: 34,
      cacheWrite: 100,
      cacheRead: 200,
      costUsd: null,
      isSidechain: false,
    });
    expect(entries[1]?.promptText).toBe('Second question\nabout offsets');
    expect(entries[2]?.promptText).toBe('Second question\nabout offsets');
  });

  test('block lines of one assistant message share the msg: natural id', async () => {
    // Arrange — one API response written as two JSONL lines (text block +
    // tool_use block) with distinct uuids but the same message.id, the
    // usage snapshot growing on the later line
    const dir = makeTempDir();
    const path = join(dir, 'session.jsonl');
    const base = {
      type: 'assistant',
      parentUuid: 'u1',
      isSidechain: false,
      sessionId: 'sess-dup',
      cwd: '/tmp/proj',
      requestId: 'req_dup',
      effort: 'high',
    };
    const usage = (outputTokens: number) => ({
      role: 'assistant',
      id: 'msg_dup01',
      model: 'claude-fable-5',
      usage: { input_tokens: 3, output_tokens: outputTokens },
    });
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, message: { role: 'user', content: 'dup question' } })}\n${JSON.stringify({ ...base, uuid: 'a1', timestamp: '2026-08-01T10:00:05.000Z', message: usage(7) })}\n${JSON.stringify({ ...base, uuid: 'a2', timestamp: '2026-08-01T10:00:06.000Z', message: usage(250) })}\n`,
    );

    // Act
    const { entries } = await scanAll(path);

    // Assert — both lines resolve to one natural id so the ledger unique
    // key collapses them; the second carries the final (billed) snapshot
    expect(entries.map((entry) => entry.naturalId)).toEqual(['msg:msg_dup01', 'msg:msg_dup01']);
    expect(entries.map((entry) => entry.outputTokens)).toEqual([7, 250]);
  });

  test('keeps sidechain usage separate from the main prompt', async () => {
    // Act
    const { entries, batches } = await scanAll(fixturePath('claude-code', 'sidechain.jsonl'));
    const byId = new Map(entries.map((entry) => [entry.naturalId, entry]));

    // Assert
    expect(byId.get('ma1')?.promptText).toBe('Main task prompt');
    expect(byId.get('ma2')?.promptText).toBe('Main task prompt');
    expect(byId.get('sa1')?.promptText).toBe('Subagent instruction');
    expect(byId.get('sa2')?.promptText).toBe('Subagent instruction');
    expect(byId.get('sa1')?.isSidechain).toBe(true);
    expect(byId.get('sa3')?.promptText).toBeNull();
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));
    expect(codes).toContain('prompt_unresolved');
  });

  test('reports malformed lines and holds the truncated tail', async () => {
    // Act
    const { entries, batches } = await scanAll(fixturePath('claude-code', 'tail.jsonl'));
    const last = batches[batches.length - 1];
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(entries.map((entry) => entry.naturalId)).toEqual(['ta1']);
    expect(codes).toContain('malformed_json');
    expect(last?.tailPending).toBe(true);
  });

  test('resumes from the committed offset and only emits appended records', async () => {
    // Arrange
    const dir = makeTempDir();
    const path = join(dir, 'session.jsonl');
    copyFileSync(fixturePath('claude-code', 'basic.jsonl'), path);
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);
    appendFileSync(
      path,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'a4',
        parentUuid: 'a3',
        isSidechain: false,
        sessionId: 'sess-basic',
        cwd: '/tmp/proj',
        timestamp: '2026-08-01T10:02:00.000Z',
        requestId: 'req_003',
        effort: 'high',
        message: {
          role: 'assistant',
          model: 'claude-fable-5',
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      })}\n`,
    );

    // Act
    const second = await scanAll(path, state);

    // Assert
    expect(second.entries.map((entry) => entry.naturalId)).toEqual(['a4']);
    expect(second.entries[0]?.promptText).toBe('Second question\nabout offsets');
  });

  test('resets the cursor when the file is replaced with different content', async () => {
    // Arrange
    const dir = makeTempDir();
    const path = join(dir, 'session.jsonl');
    copyFileSync(fixturePath('claude-code', 'basic.jsonl'), path);
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);
    writeFileSync(path, '');
    copyFileSync(fixturePath('claude-code', 'sidechain.jsonl'), path);

    // Act
    const second = await scanAll(path, state);
    const codes = second.batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(codes).toContain('cursor_reset');
    expect(second.entries.map((entry) => entry.naturalId)).toContain('ma1');
  });

  test('emits a recoverable warning when the source file disappeared', async () => {
    // Arrange
    const dir = makeTempDir();
    const path = join(dir, 'session.jsonl');
    copyFileSync(fixturePath('claude-code', 'basic.jsonl'), path);
    const target = targetFor(path);
    const adapter = new ClaudeCodeAdapter();
    writeFileSync(`${path}.moved`, '');

    // Act
    const batches: ScanBatch[] = [];
    const { unlinkSync } = await import('node:fs');
    unlinkSync(path);
    for await (const batch of adapter.scan(target, null, { fullRescan: false, scanCeilingBytes: null })) {
      batches.push(batch);
    }

    // Assert
    expect(batches).toHaveLength(1);
    expect(batches[0]?.warnings[0]?.code).toBe('source_missing');
    expect(batches[0]?.nextOffset).toBeNull();
  });

  test('discover finds fixture files under an overridden root', async () => {
    // Arrange
    const adapter = new ClaudeCodeAdapter({ rootDirectory: fixturePath('claude-code') });

    // Act
    const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });

    // Assert
    expect(discovery.targets.map((target) => target.path)).toEqual([
      fixturePath('claude-code', 'basic.jsonl'),
      fixturePath('claude-code', 'sidechain.jsonl'),
      fixturePath('claude-code', 'tail.jsonl'),
    ]);
  });
});
