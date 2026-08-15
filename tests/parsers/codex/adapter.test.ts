import { describe, expect, test } from 'bun:test';
import { appendFileSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { CodexAdapter } from '@llmtally/core/parsers/codex/adapter.ts';
import { fingerprintFile } from '@llmtally/core/scan/file-discovery.ts';
import type { ScanBatch, SourceTarget, StoredScanState } from '@llmtally/core/scan/types.ts';
import { fixturePath, makeTempDir } from '../../helpers.ts';

function targetFor(path: string): SourceTarget {
  const stats = statSync(path);
  return {
    agent: 'codex',
    path,
    kind: 'jsonl',
    fingerprint: fingerprintFile(path, stats.size, stats.dev, stats.ino),
  };
}

async function scanAll(
  path: string,
  state: StoredScanState | null = null,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[] }> {
  const adapter = new CodexAdapter();
  const batches: ScanBatch[] = [];
  const entries: LedgerEntry[] = [];
  for await (const batch of adapter.scan(targetFor(path), state, {
    fullRescan: false,
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
    agent: 'codex',
    path,
    mtime: last.sourceMtime ?? 0,
    size: last.sourceSize ?? 0,
    lastOffset: last.nextOffset,
    cursorJson: last.nextCursor,
  };
}

describe('CodexAdapter.scan', () => {
  test('collects usage per turn with raw tokens and filtered prompts', async () => {
    // Act
    const { entries } = await scanAll(fixturePath('codex', 'basic.jsonl'));

    // Assert — duplicate snapshot and null-info events produce no rows
    expect(entries).toHaveLength(2);
    expect(entries[0]?.naturalId).toStartWith('turn:turn-b1:usage:');
    expect(entries[1]?.naturalId).toStartWith('turn:turn-b2:usage:');
    expect(entries[0]).toMatchObject({
      agent: 'codex',
      provider: 'openai',
      model: 'gpt-5.5',
      effort: 'xhigh',
      promptText: 'optimize the parser',
      promptKey: 'turn-b1',
      inputTokens: 100,
      cacheRead: 40,
      outputTokens: 20,
      reasoningTokens: 5,
      costUsd: null,
      sessionId: 'sess-root',
      isSidechain: false,
    });
    expect(entries[1]).toMatchObject({
      model: 'gpt-5.6-luna',
      effort: 'high',
      promptText: 'second question',
      promptKey: 'turn-b2',
      inputTokens: 50,
      cacheWrite: 10,
      reasoningTokens: 8,
    });
  });

  test('a spawned subagent takes its NEW_TASK mail as the prompt and keeps it across a compaction re-emit', async () => {
    // Act
    const { entries } = await scanAll(fixturePath('codex', 'subagent-spawn.jsonl'));

    // Assert — four usage events: three on turn-s1 (incl. one after the
    // same-turn turn_context re-emit), one on turn-s2 driven by peer MESSAGE
    expect(entries).toHaveLength(4);
    const taskPrompt = 'Message Type: NEW_TASK\nTask name: /root/audit\nSender: /root\nPayload: [encrypted payload]';
    for (const entry of entries.slice(0, 3)) {
      expect(entry.promptText).toBe(taskPrompt);
      expect(entry.promptKey).toBe('turn-s1');
      expect(entry.isSidechain).toBe(true);
    }
    // outgoing mail and the child's FINAL_ANSWER never became prompts
    expect(entries[1]?.promptText).not.toContain('helper');
    expect(entries[3]).toMatchObject({
      promptKey: 'turn-s2',
      promptText: 'Message Type: MESSAGE\nTask name: /root/audit\nSender: /root/other\nPayload:\nplease also check X',
    });
  });

  test('turnless usage carries no prompt key', async () => {
    // Act
    const { entries } = await scanAll(fixturePath('codex', 'turnless.jsonl'));

    // Assert
    expect(entries[0]?.promptKey).toBeNull();
  });

  test('the agent path survives a cursor round trip so later mail is still recognised', async () => {
    // Arrange — scan up to the first usage, then resume with the stored cursor
    const dir = makeTempDir();
    const path = join(dir, 'rollout-spawn-resume.jsonl');
    const lines = (await Bun.file(fixturePath('codex', 'subagent-spawn.jsonl')).text())
      .split('\n')
      .filter((line) => line.length > 0);
    const firstUsageIndex = lines.findIndex((line) => line.includes('"token_count"'));
    await Bun.write(path, `${lines.slice(0, firstUsageIndex + 1).join('\n')}\n`);
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);
    expect(state.cursorJson.agentPath).toBe('/root/audit');
    appendFileSync(path, `${lines.slice(firstUsageIndex + 1).join('\n')}\n`);

    // Act
    const second = await scanAll(path, state);

    // Assert — the peer MESSAGE after the resume point still binds to turn-s2
    expect(second.entries).toHaveLength(3);
    expect(second.entries[2]).toMatchObject({
      promptKey: 'turn-s2',
      promptText: expect.stringContaining('please also check X'),
    });
  });

  test('replayed parent usage in a subagent rollout keeps the parent natural id', async () => {
    // Act
    const parent = await scanAll(fixturePath('codex', 'replay-parent.jsonl'));
    const child = await scanAll(fixturePath('codex', 'replay-child.jsonl'));

    // Assert — the replayed event carries the same key so the ledger dedupes it
    expect(parent.entries).toHaveLength(1);
    expect(child.entries).toHaveLength(2);
    expect(child.entries[0]?.naturalId).toBe(parent.entries[0]?.naturalId ?? '');
    expect(child.entries[1]?.naturalId).toStartWith('turn:turn-c1:usage:');
    expect(child.entries[0]?.isSidechain).toBe(true);
    expect(child.entries[0]?.parentUuid).toBe('rollout-parent');
  });

  test('turnless usage falls back to rollout offset ids with unknown model', async () => {
    // Act
    const { entries, batches } = await scanAll(fixturePath('codex', 'turnless.jsonl'));
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0]?.naturalId).toStartWith('rollout:rollout-turnless:offset:');
    expect(entries[0]?.model).toBe('unknown');
    expect(codes).toContain('prompt_unresolved');
  });

  test('reports malformed lines and holds the truncated tail', async () => {
    // Act
    const { entries, batches } = await scanAll(fixturePath('codex', 'tail.jsonl'));
    const last = batches[batches.length - 1];
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0]?.naturalId).toStartWith('turn:turn-t1:usage:');
    expect(codes).toContain('malformed_json');
    expect(last?.tailPending).toBe(true);
  });

  test('resumes from the committed offset and dedupes appended duplicate snapshots', async () => {
    // Arrange
    const dir = makeTempDir();
    const path = join(dir, 'rollout-resume.jsonl');
    copyFileSync(fixturePath('codex', 'basic.jsonl'), path);
    const first = await scanAll(path);
    const state = stateFromLastBatch(path, first.batches);
    const duplicateSnapshot = JSON.stringify({
      timestamp: '2026-08-01T09:02:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 150,
            cached_input_tokens: 40,
            cache_write_input_tokens: 10,
            output_tokens: 50,
            reasoning_output_tokens: 8,
            total_tokens: 300,
          },
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 0,
            cache_write_input_tokens: 10,
            output_tokens: 30,
            reasoning_output_tokens: 8,
            total_tokens: 98,
          },
        },
        rate_limits: {},
      },
    });
    const newSnapshot = duplicateSnapshot
      .replace('"total_tokens":300', '"total_tokens":420')
      .replace('"output_tokens":50', '"output_tokens":90');
    appendFileSync(path, `${duplicateSnapshot}\n${newSnapshot}\n`);

    // Act
    const second = await scanAll(path, state);

    // Assert — the duplicate total is skipped across the resume boundary,
    // the changed total yields a new distinct key on the same turn
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.naturalId).toStartWith('turn:turn-b2:usage:');
    expect(second.entries[0]?.naturalId).not.toBe(first.entries[1]?.naturalId ?? '');
    expect(second.entries[0]?.sessionId).toBe('sess-root');
    expect(second.entries[0]?.promptText).toBe('second question');
  });

  test('distinct usage survives a re-emitted turn_context for the same turn', async () => {
    // Arrange — resumed rollouts re-emit turn_context for the SAME turn id,
    // which resets any per-turn counter; distinct usage must keep distinct keys
    const dir = makeTempDir();
    const path = join(dir, 'rollout-reemit.jsonl');
    copyFileSync(fixturePath('codex', 'replay-parent.jsonl'), path);
    appendFileSync(
      path,
      `${JSON.stringify({
        timestamp: '2026-08-02T11:00:00.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-p1', cwd: '/tmp/proj', model: 'gpt-5.5', effort: 'high' },
      })}\n${JSON.stringify({
        timestamp: '2026-08-02T11:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 90,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 44,
              reasoning_output_tokens: 3,
              total_tokens: 137,
            },
            last_token_usage: {
              input_tokens: 80,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 39,
              reasoning_output_tokens: 3,
              total_tokens: 122,
            },
          },
          rate_limits: {},
        },
      })}\n`,
    );

    // Act
    const { entries } = await scanAll(path);

    // Assert — both events on turn-p1 survive with distinct keys
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.naturalId)).size).toBe(2);
    expect(entries[1]?.outputTokens).toBe(39);
  });

  test('discover only returns rollout files under the codex sessions root', async () => {
    // Arrange
    const adapter = new CodexAdapter({ rootDirectory: fixturePath('codex') });

    // Act
    const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });

    // Assert — fixtures are not named rollout-*, so a plain directory yields none
    expect(discovery.targets).toHaveLength(0);
  });
});
