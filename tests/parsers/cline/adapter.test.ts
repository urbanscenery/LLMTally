import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { ClineAdapter } from '@llmtally/core/parsers/cline/adapter.ts';
import type { ScanBatch, StoredScanState } from '@llmtally/core/scan/types.ts';
import { makeTempDir } from '../../helpers.ts';

function sessionDocument() {
  return {
    sessionId: 'sess-cline-1',
    agent: 'cline',
    version: 1,
    messages: [
      { id: 'msg_u1', role: 'user', ts: 1_786_070_460_000, content: 'summarize the delivery service' },
      {
        id: 'msg_a1',
        role: 'assistant',
        ts: 1_786_070_462_298,
        modelInfo: { id: 'cline-pass/kimi-k3', provider: 'cline-pass' },
        metrics: { inputTokens: 5850, outputTokens: 244, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02121 },
      },
      // tool result masquerading as a user message must NOT become the prompt
      { id: 'msg_u2', role: 'user', ts: 1_786_070_470_000, content: [{ type: 'tool_result', content: 'file list...' }] },
      {
        id: 'msg_a2',
        role: 'assistant',
        ts: 1_786_070_475_000,
        modelInfo: { id: 'cline-pass/kimi-k3', provider: 'cline-pass' },
        metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, cost: 0.001 },
      },
      { id: 'msg_a3', role: 'assistant', ts: 1_786_070_480_000, content: 'no metrics on this one' },
      { role: 'assistant', ts: 1_786_070_485_000, metrics: { inputTokens: 1, outputTokens: 1 } },
    ],
  };
}

function writeSession(root: string, id: string, document: unknown): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ cwd: '/tmp/cline-proj', model: 'cline-pass/kimi-k3', provider: 'cline-pass', session_id: id }),
  );
  const path = join(dir, `${id}.messages.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

async function scanAll(
  root: string,
  state: StoredScanState | null = null,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[] }> {
  const adapter = new ClineAdapter({ rootDirectory: root });
  const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });
  const batches: ScanBatch[] = [];
  const entries: LedgerEntry[] = [];
  for (const target of discovery.targets) {
    for await (const batch of adapter.scan(target, state, { fullRescan: false, scanCeilingBytes: null })) {
      batches.push(batch);
      entries.push(...batch.entries);
    }
  }
  return { entries, batches };
}

describe('ClineAdapter', () => {
  test('collects assistant metrics with authoritative cost and text-only prompts', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(root, '100_abc', sessionDocument());

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert — msg_a3 (no metrics) and the id-less message are skipped
    expect(entries.map((entry) => entry.naturalId)).toEqual(['msg_a1', 'msg_a2']);
    expect(entries[0]).toMatchObject({
      agent: 'cline',
      provider: 'cline-pass',
      model: 'cline-pass/kimi-k3',
      promptText: 'summarize the delivery service',
      inputTokens: 5850,
      costUsd: 0.02121,
      sessionId: 'sess-cline-1',
      cwd: '/tmp/cline-proj',
      tsUtc: 1_786_070_462,
    });
    // the tool_result never replaced the pending prompt
    expect(entries[1]?.promptText).toBe('summarize the delivery service');
    expect(batches.flatMap((batch) => batch.warnings.map((warning) => warning.code))).toContain(
      'invalid_record',
    );
  });

  test('an unchanged file is skipped via the stored fingerprint', async () => {
    // Arrange
    const root = makeTempDir();
    const path = writeSession(root, '100_abc', sessionDocument());
    const first = await scanAll(root);
    const last = first.batches[first.batches.length - 1];
    const state: StoredScanState = {
      agent: 'cline',
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
  });

  test('a rewritten file is fully reparsed and yields the new messages', async () => {
    // Arrange
    const root = makeTempDir();
    const path = writeSession(root, '100_abc', sessionDocument());
    const first = await scanAll(root);
    const last = first.batches[first.batches.length - 1];
    const state: StoredScanState = {
      agent: 'cline',
      path,
      mtime: (last?.sourceMtime ?? 0) - 5_000,
      size: (last?.sourceSize ?? 0) + 1,
      lastOffset: 0,
      cursorJson: last?.nextCursor ?? {},
    };
    const extended = sessionDocument();
    extended.messages.push({
      id: 'msg_a9',
      role: 'assistant',
      ts: 1_786_070_500_000,
      modelInfo: { id: 'cline-pass/kimi-k3', provider: 'cline-pass' },
      metrics: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.0001 },
    });
    writeFileSync(path, JSON.stringify(extended));

    // Act
    const second = await scanAll(root, state);

    // Assert — full reparse; ledger dedup handles the repeats
    expect(second.entries.map((entry) => entry.naturalId)).toEqual(['msg_a1', 'msg_a2', 'msg_a9']);
  });

  test('malformed json warns without advancing the cursor', async () => {
    // Arrange
    const root = makeTempDir();
    const dir = join(root, '200_bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '200_bad.messages.json'), '{broken');

    // Act
    const { batches } = await scanAll(root);

    // Assert
    expect(batches[0]?.nextOffset).toBeNull();
    expect(batches[0]?.warnings[0]?.code).toBe('malformed_json');
  });

  test('a missing session root is a recoverable discovery warning', async () => {
    // Act
    const adapter = new ClineAdapter({ rootDirectory: join(makeTempDir(), 'none') });
    const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });

    // Assert
    expect(discovery.targets).toHaveLength(0);
    expect(discovery.warnings[0]?.code).toBe('source_missing');
  });
});
