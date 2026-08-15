import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { listPrompts, loadPromptDetail, PROMPT_TEXT_LIMIT } from '@llmtally/core/report/prompts.ts';
import type { PromptListRequest } from '@llmtally/core/report/prompts.ts';
import { makeTempDir } from '../helpers.ts';

const LITELLM_PAYLOAD = {
  'claude-fable-5': {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
  },
  'tiered-model': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    input_cost_per_token_above_100k_tokens: 1e-5,
  },
};

interface SeedRow {
  readonly tsUtc: number;
  readonly agent?: string;
  readonly provider?: string | null;
  readonly model?: string;
  readonly sessionId?: string | null;
  readonly promptText?: string | null;
  readonly promptKey?: string | null;
  readonly isSidechain?: boolean;
  readonly cwd?: string | null;
  readonly input?: number;
  readonly output?: number;
  readonly cost?: number | null;
}

const T0 = 1_786_500_000;

function seedLedger(rows: readonly SeedRow[]): string {
  const path = join(makeTempDir(), 'ledger.db');
  const db = openDatabase(path);
  migrate(db);
  const insert = db.prepare(
    `INSERT INTO usage_ledger
      (ts_utc, agent, provider, model, session_id, prompt_text, prompt_key, is_sidechain,
       natural_id, parser_version, input_tokens, output_tokens, cache_write, cache_read,
       reasoning_tokens, cost_usd, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, ?, ?)`,
  );
  rows.forEach((row, index) => {
    insert.run(
      row.tsUtc,
      row.agent ?? 'claude-code',
      row.provider === undefined ? 'anthropic' : row.provider,
      row.model ?? 'claude-fable-5',
      row.sessionId === undefined ? 'sess-1' : row.sessionId,
      row.promptText === undefined ? 'fix the bug' : row.promptText,
      row.promptKey === undefined ? null : row.promptKey,
      row.isSidechain === true ? 1 : 0,
      `seed-${index}`,
      row.input ?? 100,
      row.output ?? 10,
      row.cost === undefined ? null : row.cost,
      row.cwd === undefined ? null : row.cwd,
    );
  });
  db.close();
  return path;
}

function request(databasePath: string, overrides: Partial<PromptListRequest> = {}): PromptListRequest {
  return { databasePath, model: null, agent: null, search: null, limit: 100, noRefresh: false, ...overrides };
}

function deps() {
  return {
    fetchFn: (url: string) =>
      Promise.resolve(
        new Response(JSON.stringify(url.includes('litellm') ? LITELLM_PAYLOAD : { data: [] })),
      ),
    cacheDir: makeTempDir(),
    configPath: join(makeTempDir(), 'config.json'),
  };
}

describe('listPrompts grouping', () => {
  test('folds every call sharing a prompt key into one row with summed tokens and per-call cost', async () => {
    // Arrange — one prompt, three API calls (tool round-trips)
    const path = seedLedger([
      { tsUtc: T0, promptKey: 'u-1', input: 100, output: 10 },
      { tsUtc: T0 + 5, promptKey: 'u-1', input: 200, output: 20 },
      { tsUtc: T0 + 9, promptKey: 'u-1', input: 300, output: 30 },
    ]);

    // Act
    const result = await listPrompts(request(path), deps());

    // Assert
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.calls).toBe(3);
    expect(row.tsUtc).toBe(T0);
    expect(row.tokens.inputTokens).toBe(600);
    expect(row.tokens.outputTokens).toBe(60);
    // 600 * 1e-5 + 60 * 5e-5 = 0.009 — same as pricing each call and summing
    expect(row.costUsd).toBeCloseTo(0.009, 10);
    expect(row.text).toBe('fix the bug');
    expect(result.truncated).toBe(false);
  });

  test('sums per-call prices so a long prompt never crosses a tier its calls did not', async () => {
    // Arrange — two calls of 60k input each; summed 120k would hit the >100k tier
    const path = seedLedger([
      { tsUtc: T0, model: 'tiered-model', promptKey: 't-1', input: 60_000, output: 0 },
      { tsUtc: T0 + 1, model: 'tiered-model', promptKey: 't-1', input: 60_000, output: 0 },
    ]);

    // Act
    const result = await listPrompts(request(path), deps());

    // Assert — 120k * 1e-6 = 0.12, not 120k * 1e-5 = 1.2
    expect(result.rows[0]?.costUsd).toBeCloseTo(0.12, 10);
  });

  test('rows without a key group by their words within a session; other sessions stay apart', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: T0, promptText: 'continue', sessionId: 'a' },
      { tsUtc: T0 + 1, promptText: 'continue', sessionId: 'a' },
      { tsUtc: T0 + 2, promptText: 'continue', sessionId: 'b' },
    ]);

    // Act
    const result = await listPrompts(request(path), deps());

    // Assert — newest prompt first
    expect(result.rows.map((row) => [row.calls, row.tsUtc])).toEqual([
      [1, T0 + 2],
      [2, T0],
    ]);
  });

  test('rows with neither key nor text stand alone instead of merging into one blob', async () => {
    // Arrange — aged-out prompts of a legacy session
    const path = seedLedger([
      { tsUtc: T0, promptText: null },
      { tsUtc: T0 + 1, promptText: null },
    ]);

    // Act
    const result = await listPrompts(request(path), deps());

    // Assert
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.calls === 1 && row.text === '')).toBe(true);
  });

  test('a model filter groups within the model and never merges models under one key', async () => {
    // Arrange — the same prompt answered by two models (e.g. a haiku side call)
    const path = seedLedger([
      { tsUtc: T0, promptKey: 'u-1', model: 'claude-fable-5' },
      { tsUtc: T0 + 1, promptKey: 'u-1', model: 'claude-fable-5' },
      { tsUtc: T0 + 2, promptKey: 'u-1', model: 'claude-haiku-4-5' },
    ]);

    // Act
    const all = await listPrompts(request(path), deps());
    const filtered = await listPrompts(request(path, { model: 'claude-fable-5' }), deps());

    // Assert
    expect(all.rows.map((row) => [row.model, row.calls])).toEqual([
      ['claude-haiku-4-5', 1],
      ['claude-fable-5', 2],
    ]);
    expect(filtered.rows.map((row) => [row.model, row.calls])).toEqual([['claude-fable-5', 2]]);
  });

  test('a search matches prompts as a whole and returns all of their calls', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: T0, promptKey: 'u-1', promptText: 'refactor the parser' },
      { tsUtc: T0 + 1, promptKey: 'u-1', promptText: 'refactor the parser' },
      { tsUtc: T0 + 2, promptKey: 'u-2', promptText: 'write docs' },
    ]);

    // Act
    const result = await listPrompts(request(path, { search: 'parser' }), deps());

    // Assert
    expect(result.rows.map((row) => [row.text, row.calls])).toEqual([['refactor the parser', 2]]);
  });

  test('the limit counts prompts, not calls, and reports truncation', async () => {
    // Arrange — 3 prompts × 2 calls
    const path = seedLedger(
      [0, 1, 2].flatMap((prompt) => [
        { tsUtc: T0 + prompt * 10, promptKey: `p-${prompt}` },
        { tsUtc: T0 + prompt * 10 + 1, promptKey: `p-${prompt}` },
      ]),
    );

    // Act
    const result = await listPrompts(request(path, { limit: 2 }), deps());

    // Assert — the two newest prompts, each whole
    expect(result.rows.map((row) => [row.calls, row.tsUtc])).toEqual([
      [2, T0 + 20],
      [2, T0 + 10],
    ]);
    expect(result.truncated).toBe(true);
  });

  test('an unpriced call makes the whole prompt unpriced and sidechain is carried through', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: T0, promptKey: 'u-1', isSidechain: true },
      { tsUtc: T0 + 1, promptKey: 'u-1', model: 'claude-fable-5', isSidechain: true },
      { tsUtc: T0 + 2, promptKey: 'u-2', model: 'mystery-model' },
    ]);

    // Act
    const result = await listPrompts(request(path), deps());

    // Assert
    const [mystery, sidechain] = result.rows;
    expect(mystery?.costUsd).toBeNull();
    expect(sidechain?.isSidechain).toBe(true);
    expect(sidechain?.costUsd).not.toBeNull();
  });
});

describe('loadPromptDetail', () => {
  test('returns the full prompt body and every call, priced one by one', async () => {
    // Arrange — a body longer than the list clip, answered by three calls
    const body = 'x'.repeat(PROMPT_TEXT_LIMIT + 50);
    const path = seedLedger([
      { tsUtc: T0, promptKey: 'u-1', promptText: body, input: 100, output: 10, cwd: '/proj' },
      { tsUtc: T0 + 5, promptKey: 'u-1', promptText: body, input: 200, output: 20 },
      { tsUtc: T0 + 9, promptKey: 'u-1', promptText: body, model: 'claude-haiku-4-5', input: 1, output: 1 },
      { tsUtc: T0 + 20, promptKey: 'u-2', promptText: 'unrelated' },
    ]);
    const listed = await listPrompts(request(path, { model: 'claude-fable-5' }), deps());
    const listedPrompt = listed.rows.find((row) => row.text.startsWith('x'))!;
    const firstId = listedPrompt.id;

    // Act — the list hands over the first call's id
    const detail = await loadPromptDetail({ databasePath: path, id: firstId }, deps());

    // Assert — the whole body, the group is per model, calls oldest first
    expect(listedPrompt.text).toHaveLength(PROMPT_TEXT_LIMIT);
    expect(detail?.prompt.text).toBe(body);
    expect(detail?.prompt.calls).toBe(2);
    expect(detail?.calls.map((call) => [call.tsUtc, call.tokens.inputTokens])).toEqual([
      [T0, 100],
      [T0 + 5, 200],
    ]);
    expect(detail?.prompt.tokens.inputTokens).toBe(300);
    expect(detail?.prompt.costUsd).toBeCloseTo(300 * 1e-5 + 30 * 5e-5, 10);
    expect(detail?.lastTsUtc).toBe(T0 + 5);
    expect(detail?.cwd).toBe('/proj');
    expect(detail?.sessionId).toBe('sess-1');
    expect(detail?.provider).toBe('anthropic');
  });

  test('a vanished id yields null instead of an empty prompt', async () => {
    // Arrange
    const path = seedLedger([{ tsUtc: T0, promptKey: 'u-1' }]);

    // Act
    const detail = await loadPromptDetail({ databasePath: path, id: 999 }, deps());

    // Assert
    expect(detail).toBeNull();
  });
});
