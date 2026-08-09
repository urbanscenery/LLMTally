import type { Database } from 'bun:sqlite';

import type { ReportGroupBy, ReportQuery, ReportRow, ReportUsageRow } from './types.ts';

/**
 * The GROUP BY expression is chosen from this allowlist only — user
 * input never reaches SQL identifiers; dates and agents are always
 * bind parameters.
 */
const GROUP_EXPRESSIONS: Readonly<Record<ReportGroupBy, string>> = {
  day: "date(ts_utc, 'unixepoch', 'localtime')",
  model: 'model',
  agent: 'agent',
};

interface AggregateSqlRow {
  readonly bucket: string;
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string;
  readonly row_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_write: number;
  readonly cache_read: number;
  readonly reasoning_tokens: number;
  readonly actual_cost_usd: number | null;
  readonly actual_cost_rows: number;
  readonly max_input_tokens: number;
  readonly invalid_semantics_rows: number;
}

interface UsageSqlRow {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_write: number;
  readonly cache_read: number;
  readonly reasoning_tokens: number;
}

export class SqliteReportRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  aggregate(query: ReportQuery): readonly ReportRow[] {
    const { conditions, binds } = this.#whereParts(query);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT
        ${GROUP_EXPRESSIONS[query.groupBy]} AS bucket,
        agent, provider, model,
        COUNT(*) AS row_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_write) AS cache_write,
        SUM(cache_read) AS cache_read,
        SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(cost_usd) AS actual_cost_usd,
        COUNT(cost_usd) AS actual_cost_rows,
        MAX(input_tokens) AS max_input_tokens,
        SUM(CASE WHEN agent = 'codex' AND input_tokens < cache_read THEN 1 ELSE 0 END)
          AS invalid_semantics_rows
      FROM usage_ledger
      ${where}
      GROUP BY bucket, agent, provider, model
      ORDER BY bucket, agent, provider, model`;
    const rows = this.#db.query<AggregateSqlRow, (string | number | null)[]>(sql).all(...binds);
    return rows.map((row) => ({
      bucket: row.bucket,
      agent: row.agent,
      provider: row.provider,
      model: row.model,
      rowCount: row.row_count,
      tokens: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheWrite: row.cache_write,
        cacheRead: row.cache_read,
        reasoningTokens: row.reasoning_tokens,
      },
      actualCostUsd: row.actual_cost_usd,
      actualCostRows: row.actual_cost_rows,
      maxInputTokens: row.max_input_tokens,
      invalidSemanticsRows: row.invalid_semantics_rows,
    }));
  }

  /** Streams the ledger rows behind one aggregation group (tier pricing). */
  *iterateRowsForGroup(query: ReportQuery, group: ReportRow): IterableIterator<ReportUsageRow> {
    const { conditions, binds } = this.#whereParts(query);
    conditions.push(`${GROUP_EXPRESSIONS[query.groupBy]} = ?`);
    binds.push(group.bucket);
    conditions.push('agent = ?');
    binds.push(group.agent);
    conditions.push('model = ?');
    binds.push(group.model);
    conditions.push('provider IS ?');
    binds.push(group.provider);
    const sql = `SELECT input_tokens, output_tokens, cache_write, cache_read, reasoning_tokens
      FROM usage_ledger
      WHERE ${conditions.join(' AND ')}`;
    for (const row of this.#db
      .query<UsageSqlRow, (string | number | null)[]>(sql)
      .iterate(...binds)) {
      yield {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheWrite: row.cache_write,
        cacheRead: row.cache_read,
        reasoningTokens: row.reasoning_tokens,
      };
    }
  }

  /**
   * Date boundaries are converted with SQLite's own localtime machinery
   * (strftime 'utc' modifier treats the input as local time), so range
   * filtering can never disagree with the localtime day bucketing —
   * regardless of what the JS runtime thinks the timezone is.
   */
  #whereParts(query: ReportQuery): {
    conditions: string[];
    binds: (string | number | null)[];
  } {
    const conditions: string[] = [];
    const binds: (string | number | null)[] = [];
    if (query.range.fromDate !== null) {
      conditions.push('ts_utc >= ?');
      binds.push(this.#localMidnightUtc(query.range.fromDate, 0));
    }
    if (query.range.toDate !== null) {
      conditions.push('ts_utc < ?');
      binds.push(this.#localMidnightUtc(query.range.toDate, 1));
    }
    if (query.agent !== null) {
      conditions.push('agent = ?');
      binds.push(query.agent);
    }
    return { conditions, binds };
  }

  #localMidnightUtc(date: string, plusDays: number): number {
    const row = this.#db
      .query<{ s: number | null }, [string, string]>(
        "SELECT CAST(strftime('%s', date(?, ?), 'utc') AS INTEGER) AS s",
      )
      .get(date, `+${plusDays} day`);
    if (row === null || row.s === null) {
      throw new Error(`cannot interpret report date "${date}"`);
    }
    return row.s;
  }
}
