/**
 * Individual prompts, newest first — the drill-down behind a model row
 * and the result list behind a search. Costs are priced per row here
 * rather than reused from an aggregate: a single prompt has its own
 * tier and can be individually unpriced, and blending it into a group
 * average would misreport it.
 *
 * Actual and nominal stay separate all the way out, as everywhere else.
 */
import type { Database } from 'bun:sqlite';

import { openReadOnlyDatabase } from '../db/connection.ts';
import { LATEST_SCHEMA_VERSION } from '../db/migrate.ts';
import { nominalUsdFor, selectTierRates } from '../pricing/calculator.ts';
import type { FetchLike } from '../pricing/cache.ts';
import { loadPricing, pricingKey } from '../pricing/service.ts';
import type { NeededModel } from '../pricing/service.ts';
import type { TokenTotals } from '../pricing/types.ts';
import type { LoadedPricing } from '../pricing/service.ts';
import { escapePhraseQuery, FtsSyntaxError } from './search.ts';

export const PROMPTS_DEFAULT_LIMIT = 100;
export const PROMPTS_MAX_LIMIT = 500;
/** Enough to read the intent without pulling whole transcripts into memory. */
export const PROMPT_TEXT_LIMIT = 400;

export interface PromptFilter {
  readonly model: string | null;
  readonly agent: string | null;
  /** Free text; matched as one literal phrase against the prompt index. */
  readonly search: string | null;
  readonly limit: number;
}

export interface PromptRow {
  readonly id: number;
  readonly tsUtc: number;
  readonly agent: string;
  readonly model: string;
  readonly effort: string | null;
  readonly tokens: TokenTotals;
  /** Recorded by the source; only OpenCode and Cline have one. */
  readonly actualUsd: number | null;
  /** API-equivalent value; null when the model could not be priced. */
  readonly nominalUsd: number | null;
  readonly text: string;
}

export interface PromptListResult {
  readonly rows: readonly PromptRow[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

interface PromptSqlRow {
  readonly id: number;
  readonly ts_utc: number;
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string;
  readonly effort: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_write: number;
  readonly cache_read: number;
  readonly reasoning_tokens: number;
  readonly cost_usd: number | null;
  readonly prompt_text: string | null;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return PROMPTS_DEFAULT_LIMIT;
  }
  return Math.min(PROMPTS_MAX_LIMIT, Math.floor(limit));
}

function selectRows(db: Database, filter: PromptFilter, limit: number): PromptSqlRow[] {
  const columns = `u.id, u.ts_utc, u.agent, u.provider, u.model, u.effort,
     u.input_tokens, u.output_tokens, u.cache_write, u.cache_read, u.reasoning_tokens,
     u.cost_usd, substr(COALESCE(u.prompt_text, ''), 1, ${PROMPT_TEXT_LIMIT}) AS prompt_text`;
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  const search = filter.search === null ? null : filter.search.trim();
  // the FTS table is the join driver only when there is something to match
  const from =
    search === null || search.length === 0
      ? 'usage_ledger u'
      : 'prompt_fts f JOIN usage_ledger u ON u.id = f.rowid';
  if (search !== null && search.length > 0) {
    conditions.push('prompt_fts MATCH ?');
    binds.push(escapePhraseQuery(search));
  }
  if (filter.model !== null) {
    conditions.push('u.model = ?');
    binds.push(filter.model);
  }
  if (filter.agent !== null) {
    conditions.push('u.agent = ?');
    binds.push(filter.agent);
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const sql = `SELECT ${columns} FROM ${from} ${where} ORDER BY u.ts_utc DESC, u.id DESC LIMIT ?`;
  try {
    return db.query<PromptSqlRow, (string | number)[]>(sql).all(...binds, limit + 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('fts5')) {
      throw new FtsSyntaxError(`invalid search syntax: ${message}`);
    }
    throw error;
  }
}

export interface PromptListRequest extends PromptFilter {
  readonly databasePath: string;
  readonly noRefresh?: boolean;
}

export interface PromptListDeps {
  readonly fetchFn?: FetchLike;
  readonly cacheDir?: string;
  readonly configPath?: string;
  readonly nowUtc?: number;
}

export async function listPrompts(
  request: PromptListRequest,
  deps: PromptListDeps = {},
): Promise<PromptListResult> {
  const limit = clampLimit(request.limit);
  const db = openReadOnlyDatabase(request.databasePath, LATEST_SCHEMA_VERSION);
  let raw: PromptSqlRow[];
  try {
    raw = selectRows(db, request, limit);
  } finally {
    db.close();
  }
  const truncated = raw.length > limit;
  const rows = truncated ? raw.slice(0, limit) : raw;

  const neededByKey = new Map<string, NeededModel>();
  for (const row of rows) {
    neededByKey.set(pricingKey(row.agent, row.provider, row.model), {
      agent: row.agent,
      provider: row.provider,
      model: row.model,
    });
  }
  const pricing = await loadPricing({
    needed: [...neededByKey.values()],
    allowRefresh: request.noRefresh !== true,
    fetchFn: deps.fetchFn,
    cacheDir: deps.cacheDir,
    configPath: deps.configPath,
    nowUtc: deps.nowUtc,
  });

  return {
    rows: rows.map((row) => toPromptRow(row, pricing)),
    truncated,
    warnings: pricing.warnings,
  };
}

function toPromptRow(row: PromptSqlRow, pricing: LoadedPricing): PromptRow {
  const tokens: TokenTotals = {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWrite: row.cache_write,
    cacheRead: row.cache_read,
    reasoningTokens: row.reasoning_tokens,
  };
  return {
    id: row.id,
    tsUtc: row.ts_utc,
    agent: row.agent,
    model: row.model,
    effort: row.effort,
    tokens,
    actualUsd: row.cost_usd,
    nominalUsd: nominalFor(row, tokens, pricing),
    text: row.prompt_text ?? '',
  };
}

/** loadPricing already resolved every model we asked about. */
function nominalFor(row: PromptSqlRow, tokens: TokenTotals, pricing: LoadedPricing): number | null {
  const resolution = pricing.resolutions.get(pricingKey(row.agent, row.provider, row.model));
  if (resolution === undefined || resolution.status !== 'resolved') {
    return null;
  }
  const outcome = nominalUsdFor(
    row.agent,
    tokens,
    selectTierRates(resolution.record, tokens.inputTokens),
  );
  return outcome.ok ? outcome.usd : null;
}
