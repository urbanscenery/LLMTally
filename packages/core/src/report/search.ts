import type { Database } from 'bun:sqlite';

import type { ReportRange } from './types.ts';

const SNIPPET_TOKENS = 24;
export const SEARCH_MAX_LIMIT = 500;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_QUERY_BYTES = 4096;

export interface SearchQuery {
  readonly match: string;
  readonly rawSyntax: boolean;
  readonly agent: string | null;
  readonly range: ReportRange;
  readonly limit: number;
  readonly fullPrompt: boolean;
}

export interface SearchHit {
  readonly id: number;
  readonly tsUtc: number;
  readonly agent: string;
  readonly model: string;
  readonly sessionId: string | null;
  /** snippet by default; the full prompt only with fullPrompt. */
  readonly text: string;
}

export class FtsSyntaxError extends Error {
  override readonly name = 'FtsSyntaxError';
}

/**
 * Default mode treats the whole query as one literal phrase so FTS5
 * operators in user input cannot change the query semantics; embedded
 * quotes are doubled per FTS5 string rules.
 */
export function escapePhraseQuery(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

interface SearchSqlRow {
  readonly id: number;
  readonly ts_utc: number;
  readonly agent: string;
  readonly model: string;
  readonly session_id: string | null;
  readonly text: string;
}

export function searchPrompts(db: Database, query: SearchQuery): readonly SearchHit[] {
  const match = query.rawSyntax ? query.match : escapePhraseQuery(query.match);
  const conditions: string[] = ['prompt_fts MATCH ?'];
  const binds: (string | number)[] = [match];
  if (query.agent !== null) {
    conditions.push('u.agent = ?');
    binds.push(query.agent);
  }
  if (query.range.fromDate !== null) {
    conditions.push('u.ts_utc >= ?');
    binds.push(localMidnightUtc(db, query.range.fromDate, 0));
  }
  if (query.range.toDate !== null) {
    conditions.push('u.ts_utc < ?');
    binds.push(localMidnightUtc(db, query.range.toDate, 1));
  }
  binds.push(Math.min(Math.max(query.limit, 1), SEARCH_MAX_LIMIT));

  const textExpression = query.fullPrompt
    ? 'u.prompt_text'
    : `snippet(prompt_fts, 0, '[', ']', ' … ', ${SNIPPET_TOKENS})`;
  const sql = `SELECT u.id, u.ts_utc, u.agent, u.model, u.session_id,
      ${textExpression} AS text
    FROM prompt_fts
    JOIN usage_ledger AS u ON u.id = prompt_fts.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY prompt_fts.rank, u.ts_utc DESC, u.id DESC
    LIMIT ?`;
  let rows: SearchSqlRow[];
  try {
    rows = db.query<SearchSqlRow, (string | number)[]>(sql).all(...binds);
  } catch (error) {
    // only user-supplied FTS grammar (--raw) is a usage error; a phrase
    // query never has syntax errors, so anything else is a real fault
    if (query.rawSyntax) {
      throw new FtsSyntaxError(
        `invalid search syntax: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
  return rows.map((row) => ({
    id: row.id,
    tsUtc: row.ts_utc,
    agent: row.agent,
    model: row.model,
    sessionId: row.session_id,
    text: row.text ?? '',
  }));
}

/** Shares SQLite's localtime clock with report bucketing (see repository). */
function localMidnightUtc(db: Database, date: string, plusDays: number): number {
  const row = db
    .query<{ s: number | null }, [string, string]>(
      "SELECT CAST(strftime('%s', date(?, ?), 'utc') AS INTEGER) AS s",
    )
    .get(date, `+${plusDays} day`);
  if (row === null || row.s === null) {
    throw new Error(`cannot interpret search date "${date}"`);
  }
  return row.s;
}
