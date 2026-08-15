import type { Database } from 'bun:sqlite';

import type { ReportGroupBy, ReportQuery, ReportRow, ReportUsageRow } from './types.ts';

/**
 * The GROUP BY expression is chosen from this allowlist only — user
 * input never reaches SQL identifiers; dates and agents are always
 * bind parameters.
 */
const GROUP_EXPRESSIONS: Readonly<Record<ReportGroupBy, string>> = {
  day: "date(ts_utc, 'unixepoch', 'localtime')",
  hour: "strftime('%Y-%m-%d %H:00', ts_utc, 'unixepoch', 'localtime')",
  model: 'model',
  agent: 'agent',
};

/**
 * Ceiling on aggregation groups one report may materialize (audit
 * D-05). Legitimate ledgers stay in the low thousands (days × agents ×
 * models); the only way past this is a corrupt or adversarial source
 * injecting unique model strings, and the answer to that is a
 * diagnosable refusal — never a silently truncated total, and never a
 * gigabyte of JS rows.
 */
export const MAX_REPORT_GROUPS = 5000;

/**
 * One prompt across the ledger: the source's own key, namespaced by
 * agent; a row without a key stands for itself. Mirrors the grouping in
 * prompts.ts so counts and the prompt list agree.
 */
const PROMPT_IDENTITY_SQL = "agent || '|' || COALESCE(prompt_key, 'row:' || id)";

export interface PromptCounts {
  /** Distinct prompts per bucket key (same expression as the aggregate). */
  readonly byBucket: ReadonlyMap<string, number>;
  /** Distinct prompts over the whole query. */
  readonly total: number;
}

export class ReportCardinalityError extends Error {
  override readonly name = 'ReportCardinalityError';

  constructor(groupCount: number) {
    super(
      `report would aggregate more than ${MAX_REPORT_GROUPS} groups (${groupCount}+) — narrow the date range or filter by agent; this usually means a source is injecting bogus model names`,
    );
  }
}

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
  readonly stamped_cost_usd: number | null;
  readonly stamped_cost_rows: number;
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

  /**
   * How many groups the aggregate would produce, counted inside SQL
   * with a LIMIT so the answer itself is bounded: at most "cap + 1",
   * which is all a caller needs to refuse.
   */
  countGroups(query: ReportQuery): number {
    const { conditions, binds } = this.#whereParts(query);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM usage_ledger
        ${where}
        GROUP BY ${GROUP_EXPRESSIONS[query.groupBy]}, agent, provider, model
        LIMIT ${MAX_REPORT_GROUPS + 1}
      )`;
    return this.#db.query<{ n: number }, (string | number | null)[]>(sql).get(...binds)?.n ?? 0;
  }

  /**
   * Distinct prompts per display bucket and overall. Kept apart from
   * `aggregate` because prompt identity must not be summed across the
   * (agent, provider, model) grain: one prompt answered by two models is
   * still one prompt in its day. Keys of the returned map follow the
   * same bucket expression as `aggregate`, so they line up with
   * `bucketKeyFor`.
   */
  countPrompts(query: ReportQuery): PromptCounts {
    const { conditions, binds } = this.#whereParts(query);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const byBucketSql = `SELECT ${GROUP_EXPRESSIONS[query.groupBy]} AS bucket,
        COUNT(DISTINCT ${PROMPT_IDENTITY_SQL}) AS prompt_count
      FROM usage_ledger
      ${where}
      GROUP BY bucket`;
    const totalSql = `SELECT COUNT(DISTINCT ${PROMPT_IDENTITY_SQL}) AS prompt_count
      FROM usage_ledger
      ${where}`;
    const byBucket = new Map<string, number>();
    for (const row of this.#db
      .query<{ bucket: string; prompt_count: number }, (string | number | null)[]>(byBucketSql)
      .all(...binds)) {
      byBucket.set(row.bucket, row.prompt_count);
    }
    const total = this.#db
      .query<{ prompt_count: number }, (string | number | null)[]>(totalSql)
      .get(...binds)?.prompt_count ?? 0;
    return { byBucket, total };
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
        SUM(cost_usd) AS stamped_cost_usd,
        COUNT(cost_usd) AS stamped_cost_rows,
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
      stampedCostUsd: row.stamped_cost_usd,
      stampedCostRows: row.stamped_cost_rows,
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
