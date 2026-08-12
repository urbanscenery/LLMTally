import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { GrokAdapter } from '@llmtally/core/parsers/grok/adapter.ts';
import type { ScanBatch, StoredScanState } from '@llmtally/core/scan/types.ts';
import { makeTempDir } from '../../helpers.ts';

const PROJECT_DIR = '%2FUsers%2Fdev%2Fproj';
const SESSION_ID = '019ff69c-57cc-7061-a0d4-a1fa09334f18';

function userChunk(promptIndex: number, text: string, agentTimestampMs: number): string {
  return JSON.stringify({
    timestamp: Math.floor(agentTimestampMs / 1000),
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: { modelId: 'grok-4.6', promptIndex },
      },
      _meta: { eventId: `${SESSION_ID}-${promptIndex}`, agentTimestampMs },
    },
  });
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
    inputTokens: 60722,
    outputTokens: 128,
    totalTokens: 60850,
    cachedReadTokens: 2944,
    cacheCreationTokens: 0,
    reasoningTokens: 116,
    modelCalls: 1,
    apiDurationMs: 5249,
    costUsdTicks: 1_177_960_000,
    ...overrides,
  };
}

function turnCompleted(
  promptId: string,
  agentTimestampMs: number,
  modelUsage: Record<string, unknown> = { 'grok-4.6-build': usage() },
): string {
  return JSON.stringify({
    timestamp: Math.floor(agentTimestampMs / 1000),
    method: '_x.ai/session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: promptId,
        stop_reason: 'end_turn',
        usage: { ...usage(), modelUsage, numTurns: 1 },
      },
      _meta: { eventId: `${SESSION_ID}-turn`, agentTimestampMs },
    },
  });
}

/** A tool result echoing source code that happens to name the record type. */
function noiseLine(): string {
  return JSON.stringify({
    timestamp: 1_786_549_040,
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        rawInput: { content: 'case "turn_completed": handle("user_message_chunk")' },
      },
      _meta: { eventId: `${SESSION_ID}-noise`, agentTimestampMs: 1_786_549_040_000 },
    },
  });
}

interface SessionOptions {
  readonly summary?: Record<string, unknown> | null;
  readonly siblings?: boolean;
}

function writeSession(root: string, lines: readonly string[], options: SessionOptions = {}): string {
  const dir = join(root, PROJECT_DIR, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const summary =
    options.summary === undefined
      ? {
          info: { id: SESSION_ID, cwd: '/Users/dev/proj' },
          current_model_id: 'grok-4.6',
          reasoning_effort: 'high',
        }
      : options.summary;
  if (summary !== null) {
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary));
  }
  if (options.siblings === true) {
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn_started' })}\n`);
    writeFileSync(join(dir, 'chat_history.jsonl'), `${JSON.stringify({ type: 'user' })}\n`);
    writeFileSync(join(root, PROJECT_DIR, 'prompt_history.jsonl'), '{"prompt":"hi"}\n');
  }
  const path = join(dir, 'updates.jsonl');
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

async function scanAll(
  root: string,
  state: StoredScanState | null = null,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[]; paths: string[] }> {
  const adapter = new GrokAdapter({ rootDirectory: root });
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
    agent: 'grok',
    path,
    mtime: last.sourceMtime ?? 0,
    size: last.sourceSize ?? 0,
    lastOffset: last.nextOffset,
    cursorJson: last.nextCursor,
  };
}

describe('GrokAdapter.discover', () => {
  test('takes only updates.jsonl, never the sibling transcripts', async () => {
    // Arrange
    const root = makeTempDir();
    const path = writeSession(root, [userChunk(0, 'hi', 1_786_549_038_210)], { siblings: true });

    // Act
    const { paths } = await scanAll(root);

    // Assert
    expect(paths).toEqual([path]);
  });
});

describe('GrokAdapter.scan', () => {
  test('bills a completed turn to the prompt that opened it', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(root, [
      userChunk(0, 'hi', 1_786_549_038_210),
      noiseLine(),
      turnCompleted('p-1', 1_786_549_043_666),
    ]);

    // Act
    const { entries } = await scanAll(root);

    // Assert — the noise line names both record types but is neither
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'grok',
      provider: 'xai',
      model: 'grok-4.6-build',
      effort: 'high',
      promptText: 'hi',
      inputTokens: 60722,
      outputTokens: 128,
      cacheRead: 2944,
      cacheWrite: 0,
      reasoningTokens: 116,
      sessionId: SESSION_ID,
      cwd: '/Users/dev/proj',
      naturalId: `${SESSION_ID}:p-1:grok-4.6-build`,
      isSidechain: false,
    });
    // 1e10 ticks to the dollar, verified against xAI list rates
    expect(entries[0]?.costUsd).toBeCloseTo(0.117796, 9);
    expect(entries[0]?.tsUtc).toBe(1_786_549_043);
  });

  test('concatenates the chunks of one prompt and starts over on a new index', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(root, [
      userChunk(0, 'first ', 1_786_549_038_210),
      userChunk(0, 'prompt', 1_786_549_038_300),
      turnCompleted('p-1', 1_786_549_043_666),
      userChunk(1, 'second prompt', 1_786_549_826_160),
      turnCompleted('p-2', 1_786_549_866_118),
    ]);

    // Act
    const { entries } = await scanAll(root);

    // Assert
    expect(entries.map((entry) => entry.promptText)).toEqual(['first prompt', 'second prompt']);
  });

  test('writes one row per billed model when a turn used more than one', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(root, [
      userChunk(0, 'plan then build', 1_786_549_038_210),
      turnCompleted('p-1', 1_786_549_043_666, {
        'grok-4.6-build': usage(),
        'grok-4.5': usage({ inputTokens: 10, outputTokens: 2, costUsdTicks: 300_000_000 }),
      }),
    ]);

    // Act
    const { entries } = await scanAll(root);

    // Assert — both rows carry the prompt; the natural key separates them
    expect(entries.map((entry) => entry.naturalId)).toEqual([
      `${SESSION_ID}:p-1:grok-4.6-build`,
      `${SESSION_ID}:p-1:grok-4.5`,
    ]);
    expect(entries[1]).toMatchObject({ model: 'grok-4.5', inputTokens: 10, promptText: 'plan then build' });
    expect(entries[1]?.costUsd).toBeCloseTo(0.03, 9);
  });

  test('still records a turn whose prompt is outside the scan range', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(root, [turnCompleted('p-1', 1_786_549_043_666)]);

    // Act
    const { entries, batches } = await scanAll(root);
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(codes).toContain('prompt_unresolved');
    expect(entries[0]?.promptText).toBeNull();
    expect(entries[0]?.inputTokens).toBe(60722);
  });

  test('carries a pending prompt across a resume so the later turn keeps it', async () => {
    // Arrange — the prompt is committed in one scan, the turn arrives next
    const root = makeTempDir();
    const path = writeSession(root, [userChunk(0, 'long running task', 1_786_549_038_210)]);
    const first = await scanAll(root);
    const state = stateFrom(path, first.batches);
    appendFileSync(path, `${turnCompleted('p-1', 1_786_549_043_666)}\n`);

    // Act
    const second = await scanAll(root, state);
    const codes = second.batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(first.entries).toEqual([]);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.promptText).toBe('long running task');
    expect(codes).not.toContain('prompt_unresolved');
  });

  test('resets the cursor when the file is replaced with different content', async () => {
    // Arrange
    const root = makeTempDir();
    const path = writeSession(root, [
      userChunk(0, 'hi', 1_786_549_038_210),
      turnCompleted('p-1', 1_786_549_043_666),
    ]);
    const first = await scanAll(root);
    const state = stateFrom(path, first.batches);
    writeFileSync(
      path,
      `${userChunk(0, 'replaced', 1_786_549_038_210)}\n${turnCompleted('p-9', 1_786_549_043_666)}\n`,
    );

    // Act
    const second = await scanAll(root, state);
    const codes = second.batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(codes).toContain('cursor_reset');
    expect(second.entries.map((entry) => entry.naturalId)).toEqual([
      `${SESSION_ID}:p-9:grok-4.6-build`,
    ]);
  });

  test('reports malformed lines and holds a truncated tail', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(root, [
      userChunk(0, 'hi', 1_786_549_038_210),
      '{"params":{"update":{"sessionUpdate":"turn_completed"',
    ]);
    const path = join(root, PROJECT_DIR, SESSION_ID, 'updates.jsonl');
    appendFileSync(path, '{"params":{"update":{"sessionUpdate":"turn_completed"');

    // Act
    const { entries, batches } = await scanAll(root);
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(entries).toEqual([]);
    expect(codes).toContain('malformed_json');
    expect(batches[batches.length - 1]?.tailPending).toBe(true);
  });

  test('falls back to the percent-encoded project directory when summary.json is gone', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(
      root,
      [userChunk(0, 'hi', 1_786_549_038_210), turnCompleted('p-1', 1_786_549_043_666)],
      { summary: null },
    );

    // Act
    const { entries } = await scanAll(root);

    // Assert
    expect(entries[0]).toMatchObject({ cwd: '/Users/dev/proj', effort: null, sessionId: SESSION_ID });
  });

  test('rejects a turn whose usage carries no valid token counts', async () => {
    // Arrange
    const root = makeTempDir();
    writeSession(root, [
      userChunk(0, 'hi', 1_786_549_038_210),
      JSON.stringify({
        timestamp: 1_786_549_043,
        params: {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'p-bad',
            usage: { modelUsage: { 'grok-4.6-build': { inputTokens: -1 } } },
          },
          _meta: { agentTimestampMs: 1_786_549_043_666 },
        },
      }),
    ]);

    // Act
    const { entries, batches } = await scanAll(root);
    const codes = batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));

    // Assert
    expect(entries).toEqual([]);
    expect(codes).toContain('invalid_record');
  });
});
