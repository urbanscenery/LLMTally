import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { openDatabase } from '@llmtally/core/db/connection.ts';
import { migrate } from '@llmtally/core/db/migrate.ts';
import { buildReportRange, ALL_TIME_RANGE } from '@llmtally/core/report/range.ts';
import { generateReport } from '@llmtally/core/report/service.ts';
import type { ReportRequest } from '@llmtally/core/report/types.ts';
import { makeTempDir } from '../helpers.ts';

// seed epochs come from SQLite's own localtime conversion so they match
// the report bucketing exactly, even when the test runner overrides the
// JS timezone (bun test forces TZ=UTC while SQLite keeps the OS zone)
function localEpoch(localDateTime: string): number {
  const db = new Database(':memory:');
  const row = db
    .query<{ s: number }, [string]>("SELECT CAST(strftime('%s', ?, 'utc') AS INTEGER) AS s")
    .get(localDateTime);
  db.close();
  if (row === null) {
    throw new Error(`cannot convert ${localDateTime}`);
  }
  return row.s;
}

// local 23:30 on Aug 9 and 00:30 on Aug 10 straddle a local midnight
const AUG9_LATE = localEpoch('2026-08-09 23:30:00');
const AUG10_EARLY = localEpoch('2026-08-10 00:30:00');

const LITELLM_PAYLOAD = {
  'claude-fable-5': {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
  },
  'gpt-5.5': {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 3e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
  'tiered-model': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    input_cost_per_token_above_100k_tokens: 1e-5,
  },
};

interface SeedRow {
  readonly tsUtc: number;
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite?: number;
  readonly cacheRead?: number;
  readonly cost?: number | null;
}

function seedLedger(rows: readonly SeedRow[]): string {
  const path = join(makeTempDir(), 'ledger.db');
  const db = openDatabase(path);
  migrate(db);
  const insert = db.prepare(
    `INSERT INTO usage_ledger
      (ts_utc, agent, provider, model, natural_id, parser_version,
       input_tokens, output_tokens, cache_write, cache_read, reasoning_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?)`,
  );
  rows.forEach((row, index) => {
    insert.run(
      row.tsUtc,
      row.agent,
      row.provider,
      row.model,
      `seed-${index}`,
      row.input,
      row.output,
      row.cacheWrite ?? 0,
      row.cacheRead ?? 0,
      row.cost ?? null,
    );
  });
  db.close();
  return path;
}

function request(databasePath: string, overrides: Partial<ReportRequest> = {}): ReportRequest {
  return {
    groupBy: 'day',
    range: ALL_TIME_RANGE,
    agent: null,
    databasePath,
    noRefresh: false,
    ...overrides,
  };
}

function litellmFetch(): (url: string) => Promise<Response> {
  return (url) => {
    if (url.includes('litellm')) {
      return Promise.resolve(new Response(JSON.stringify(LITELLM_PAYLOAD)));
    }
    return Promise.resolve(new Response(JSON.stringify({ data: [] })));
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    fetchFn: litellmFetch(),
    cacheDir: makeTempDir(),
    configPath: join(makeTempDir(), 'config.json'),
    ...overrides,
  };
}

describe('generateReport', () => {
  test('buckets by local day and folds every quota-settled dollar into quota cost', async () => {
    // Arrange — computed (claude/codex) and source-stamped (opencode-go)
    // rows are all subscription quota, so they share ONE usage total
    const path = seedLedger([
      { tsUtc: AUG9_LATE, agent: 'claude-code', provider: 'anthropic', model: 'claude-fable-5', input: 1000, output: 200, cacheWrite: 100, cacheRead: 5000 },
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 6000, output: 100, cacheRead: 5000 },
      { tsUtc: AUG10_EARLY, agent: 'opencode', provider: 'opencode-go', model: 'kimi-k3', input: 10, output: 5, cost: 0.125 },
    ]);

    // Act
    const summary = await generateReport(request(path), deps());

    // Assert — two local days despite adjacent UTC times
    expect(summary.buckets.map((bucket) => bucket.key)).toEqual(['2026-08-09', '2026-08-10']);
    const day1 = summary.buckets[0];
    const day2 = summary.buckets[1];
    // claude: 1000*1e-5 + 200*5e-5 + 5000*1e-6 + 100*1.25e-5
    expect(day1?.quotaCost.usd).toBeCloseTo(0.02625, 10);
    // codex computed + opencode stamped, same settlement → one bucket
    expect(day2?.quotaCost.usd).toBeCloseTo(0.0105 + 0.125, 10);
    expect(summary.totals.quotaCost.usd).toBeCloseTo(0.03675 + 0.125, 10);
    // no spend evidence anywhere: zero rows, not a zero-dollar total
    expect(summary.totals.spendCost.pricedRows).toBe(0);
    expect(summary.totals.spendCost.unpricedRows).toBe(0);
    expect(summary.totals.spendCost.usd).toBeNull();
    expect(summary.totals.unknownRows).toBe(0);
    expect(summary.totals.unpricedRows).toBe(0);
  });

  test('billing override reroutes a computed agent to spend (API-key user)', async () => {
    // Arrange — the same claude row, but the user asserts API-key billing
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'claude-code', provider: 'anthropic', model: 'claude-fable-5', input: 1000, output: 200, cacheWrite: 100, cacheRead: 5000 },
    ]);
    const configPath = join(makeTempDir(), 'config.json');
    await Bun.write(
      configPath,
      JSON.stringify({ billing: { overrides: { 'claude-code/anthropic': 'spend' } } }),
    );

    // Act
    const summary = await generateReport(request(path), deps({ configPath }));

    // Assert — computed at list price, but settled as real money
    expect(summary.totals.spendCost.usd).toBeCloseTo(0.02625, 10);
    expect(summary.totals.quotaCost.pricedRows).toBe(0);
  });

  test('billing override reroutes a stamped provider to spend', async () => {
    // Arrange — hypothetical PAYG provider the default table cannot know
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'opencode', provider: 'openrouter', model: 'kimi-k3', input: 10, output: 5, cost: 0.7 },
    ]);
    const configPath = join(makeTempDir(), 'config.json');
    await Bun.write(
      configPath,
      JSON.stringify({ billing: { overrides: { 'opencode/openrouter': 'spend' } } }),
    );

    // Act
    const summary = await generateReport(request(path), deps({ configPath }));

    // Assert — the stamped dollars move buckets, never get repriced
    expect(summary.totals.spendCost.usd).toBe(0.7);
    expect(summary.totals.quotaCost.pricedRows).toBe(0);
    expect(summary.totals.unknownRows).toBe(0);
  });

  test('unlisted providers are counted as unclassified, never guessed into a total', async () => {
    // Arrange — provider the default table does not know
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'opencode', provider: 'anthropic', model: 'claude-fable-5', input: 10, output: 5, cost: 0.5 },
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 100, output: 10 },
    ]);

    // Act
    const summary = await generateReport(request(path), deps());

    // Assert — stamped amount visible as unknown, absent from both totals
    expect(summary.totals.unknownRows).toBe(1);
    expect(summary.totals.unknownUsd).toBe(0.5);
    expect(summary.totals.quotaCost.pricedRows).toBe(1);
    expect(summary.totals.spendCost.pricedRows).toBe(0);
    expect(summary.totals.unpricedRows).toBe(0);
  });

  test('unknown models stay unpriced with aggregated warnings and null totals', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'unknown', input: 10, output: 5 },
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 100, output: 10 },
    ]);

    // Act
    const summary = await generateReport(request(path), deps());

    // Assert — full usage total is null but the priced subtotal survives
    expect(summary.totals.quotaCost.usd).toBeNull();
    expect(summary.totals.quotaCost.pricedSubtotalUsd).toBeGreaterThan(0);
    expect(summary.totals.quotaCost.unpricedRows).toBe(1);
    expect(summary.totals.unpricedModels).toContain('unknown');
    expect(
      summary.totals.quotaCost.warnings.some((warning) => warning.code === 'unknown_model'),
    ).toBe(true);
  });

  test('tier-crossing groups are re-priced row by row', async () => {
    // Arrange — one small and one huge request in the same (day, model) group
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'tiered-model', input: 1000, output: 0 },
      { tsUtc: AUG10_EARLY + 60, agent: 'codex', provider: 'openai', model: 'tiered-model', input: 200_000, output: 0 },
    ]);

    // Act
    const summary = await generateReport(request(path), deps());

    // Assert — 1000*1e-6 (base) + 200000*1e-5 (above-100k tier), not a single blended rate
    expect(summary.totals.quotaCost.usd).toBeCloseTo(0.001 + 2.0, 10);
  });

  test('offline with no cache keeps the report alive with token-only output', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'claude-code', provider: 'anthropic', model: 'claude-fable-5', input: 100, output: 10 },
    ]);

    // Act
    const summary = await generateReport(
      request(path),
      deps({ fetchFn: () => Promise.reject(new Error('offline')) }),
    );

    // Assert
    expect(summary.pricing.status).toBe('absent');
    expect(summary.totals.quotaCost.usd).toBeNull();
    expect(summary.totals.rowCount).toBe(1);
    expect(summary.pricing.warnings.some((w) => w.includes('refresh failed'))).toBe(true);
  });

  test('noRefresh never calls the network', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 10, output: 1 },
    ]);
    let calls = 0;

    // Act
    await generateReport(
      request(path, { noRefresh: true }),
      deps({
        fetchFn: () => {
          calls += 1;
          return Promise.resolve(new Response('{}'));
        },
      }),
    );

    // Assert
    expect(calls).toBe(0);
  });

  test('date range filters by local calendar days and agent filter narrows rows', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: AUG9_LATE, agent: 'claude-code', provider: 'anthropic', model: 'claude-fable-5', input: 1, output: 1 },
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 1, output: 1 },
    ]);
    const range = buildReportRange('2026-08-10', '2026-08-10');
    if ('error' in range) {
      throw new Error(range.error);
    }

    // Act
    const ranged = await generateReport(request(path, { range }), deps());
    const filtered = await generateReport(request(path, { agent: 'codex' }), deps());

    // Assert
    expect(ranged.buckets.map((bucket) => bucket.key)).toEqual(['2026-08-10']);
    expect(filtered.totals.rowCount).toBe(1);
  });

  test('sql-injection-shaped agent filters are treated as plain values', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 1, output: 1 },
    ]);

    // Act
    const summary = await generateReport(
      request(path, { agent: "codex' OR '1'='1" }),
      deps(),
    );

    // Assert
    expect(summary.totals.rowCount).toBe(0);
  });

  test('an invalid codex row cannot cancel out inside a healthy group sum', async () => {
    // Arrange — invalid (input < cacheRead) and valid rows in ONE group;
    // their SUM looks valid, so only per-row repricing catches it
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 100, output: 10, cacheRead: 5000 },
      { tsUtc: AUG10_EARLY + 60, agent: 'codex', provider: 'openai', model: 'gpt-5.5', input: 20_000, output: 10, cacheRead: 5000 },
    ]);

    // Act
    const summary = await generateReport(request(path), deps());

    // Assert — valid row priced ((20000-5000)*5e-6 + 10*3e-5 + 5000*5e-7),
    // invalid row unpriced instead of blending into the sum
    expect(summary.totals.quotaCost.usd).toBeNull();
    expect(summary.totals.quotaCost.pricedRows).toBe(1);
    expect(summary.totals.quotaCost.unpricedRows).toBe(1);
    expect(summary.totals.quotaCost.pricedSubtotalUsd).toBeCloseTo(0.0778, 10);
    expect(
      summary.totals.quotaCost.warnings.some(
        (warning) => warning.code === 'invalid_token_semantics',
      ),
    ).toBe(true);
  });

  test('quota-cost and spend-cost warnings never contaminate each other', async () => {
    // Arrange — a quota row without stamped cost AND a spend-overridden
    // row with an unknown model
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'opencode', provider: 'opencode-go', model: 'kimi-k3', input: 1, output: 1, cost: null },
      { tsUtc: AUG10_EARLY, agent: 'codex', provider: 'openai', model: 'unknown', input: 1, output: 1 },
    ]);
    const configPath = join(makeTempDir(), 'config.json');
    await Bun.write(
      configPath,
      JSON.stringify({ billing: { overrides: { 'codex/openai': 'spend' } } }),
    );

    // Act
    const summary = await generateReport(request(path), deps({ configPath }));

    // Assert
    expect(summary.totals.quotaCost.warnings.map((warning) => warning.code)).toEqual([
      'missing_authoritative_cost',
    ]);
    expect(summary.totals.spendCost.warnings.map((warning) => warning.code)).toEqual([
      'unknown_model',
    ]);
  });

  test('quota rows missing their stamped cost are reported as partial quota cost', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: AUG10_EARLY, agent: 'opencode', provider: 'opencode-go', model: 'kimi-k3', input: 1, output: 1, cost: 0.5 },
      { tsUtc: AUG10_EARLY + 1, agent: 'opencode', provider: 'opencode-go', model: 'kimi-k3', input: 1, output: 1, cost: null },
    ]);

    // Act
    const summary = await generateReport(request(path), deps());

    // Assert
    expect(summary.totals.quotaCost.usd).toBeNull();
    expect(summary.totals.quotaCost.pricedSubtotalUsd).toBe(0.5);
    expect(
      summary.totals.quotaCost.warnings.some(
        (warning) => warning.code === 'missing_authoritative_cost',
      ),
    ).toBe(true);
  });
});

describe('aggregation cardinality cap (D-05)', () => {
  test('a pathological group explosion is refused, never silently truncated', async () => {
    // Arrange — 5,001 unique model strings: only a corrupt or
    // adversarial source produces this; a real ledger has dozens
    const path = seedLedger(
      Array.from({ length: 5001 }, (_, index) => ({
        tsUtc: AUG9_LATE,
        agent: 'claude-code',
        provider: null,
        model: `bogus-model-${index}`,
        input: 1,
        output: 1,
      })),
    );

    // Act & Assert — a diagnosable refusal beats a gigabyte of rows or
    // a total that quietly dropped groups
    expect(generateReport(request(path, { noRefresh: true }))).rejects.toThrow(
      /more than 5000 groups/,
    );
  });

  test('rows landing during the pricing fetch cannot slip past the cap', async () => {
    // Arrange — exactly at the cap before pricing; a concurrent scan
    // then inserts two more groups while pricing is on the network
    const path = seedLedger(
      Array.from({ length: 5000 }, (_, index) => ({
        tsUtc: AUG9_LATE,
        agent: 'claude-code',
        provider: null,
        model: `bogus-model-${index}`,
        input: 1,
        output: 1,
      })),
    );
    const fetchFn = (url: string): Promise<Response> => {
      const db = openDatabase(path);
      const insert = db.prepare(
        `INSERT INTO usage_ledger
          (ts_utc, agent, provider, model, natural_id, parser_version,
           input_tokens, output_tokens, cache_write, cache_read, reasoning_tokens, cost_usd)
         VALUES (?, 'claude-code', NULL, ?, ?, 1, 1, 1, 0, 0, 0, NULL)`,
      );
      insert.run(AUG9_LATE, 'late-model-a', 'late-a');
      insert.run(AUG9_LATE, 'late-model-b', 'late-b');
      db.close();
      return litellmFetch()(url);
    };

    // Act & Assert — the in-snapshot recheck refuses instead of
    // returning more groups than the cap promises (audit CX-2)
    expect(
      generateReport(request(path, { groupBy: 'model' }), deps({ fetchFn })),
    ).rejects.toThrow(/more than 5000 groups/);
  });

  test('an ordinary ledger is nowhere near the cap and reports normally', async () => {
    // Arrange
    const path = seedLedger([
      { tsUtc: AUG9_LATE, agent: 'claude-code', provider: null, model: 'claude-fable-5', input: 10, output: 5 },
    ]);

    // Act
    const summary = await generateReport(request(path, { noRefresh: true }));

    // Assert
    expect(summary.buckets.length).toBe(1);
  });
});
