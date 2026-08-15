/**
 * Prompts, newest first — the drill-down behind a model row and the
 * result list behind a search.
 *
 * The ledger stores one row per API CALL, and one prompt fans out into
 * many calls (every tool round-trip is a new call), so listing rows would
 * show the same prompt dozens of times. This module folds the calls back
 * into prompts: rows are grouped by the source's own prompt identity
 * (`prompt_key`), falling back to the prompt text within a session for
 * rows without a key, and rows with neither stay alone. Grouping is per
 * (agent, model) so a model filter never mixes models inside one row.
 *
 * Costs are priced per call and then summed: a single call has its own
 * tier and can be individually unpriced, and pricing the summed tokens
 * would push a long prompt into a tier no call actually reached.
 *
 * Each row carries its billing nature; spend and usage dollars stay
 * distinguishable all the way out, as everywhere else.
 */
import type { Database } from 'bun:sqlite';

import { openReadOnlyDatabase } from '../db/connection.ts';
import { LATEST_SCHEMA_VERSION } from '../db/migrate.ts';
import { billingNature, loadBillingOverrides } from '../pricing/billing-nature.ts';
import type { BillingNature, BillingOverrides } from '../pricing/billing-nature.ts';
import { isSourceAuthoritative, listPriceUsdFor, selectTierRates } from '../pricing/calculator.ts';
import type { FetchLike } from '../pricing/cache.ts';
import { defaultConfigPath } from '../pricing/config.ts';
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
  /** Ledger id of the prompt's first call. */
  readonly id: number;
  /** When the prompt was sent (its first call). */
  readonly tsUtc: number;
  readonly agent: string;
  readonly model: string;
  readonly effort: string | null;
  /** Summed over every call of the prompt. */
  readonly tokens: TokenTotals;
  /** Settlement class of this row's dollars (quota / spend / unknown). */
  readonly nature: BillingNature;
  /**
   * The prompt's one cost figure: per-call source-stamped or list-priced
   * costs summed; null when any call could not be priced.
   */
  readonly costUsd: number | null;
  readonly text: string;
  /** How many API calls this prompt produced (rows folded into this one). */
  readonly calls: number;
  /** A subagent's prompt rather than the user's own. */
  readonly isSidechain: boolean;
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
  readonly is_sidechain: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_write: number;
  readonly cache_read: number;
  readonly reasoning_tokens: number;
  readonly cost_usd: number | null;
  readonly prompt_text: string | null;
  readonly session_id: string | null;
  readonly cwd: string | null;
  readonly group_key: string;
}

/**
 * The columns a call row is read with. The list clips prompt text
 * (`PROMPT_TEXT_LIMIT`) since it only needs the gist; the detail view
 * asks for the whole body (`null`).
 */
function memberColumns(textLimit: number | null): string {
  const text = textLimit === null ? 'u.prompt_text' : `substr(u.prompt_text, 1, ${textLimit})`;
  return `u.id, u.ts_utc, u.agent, u.provider, u.model, u.effort, u.is_sidechain,
     u.input_tokens, u.output_tokens, u.cache_write, u.cache_read, u.reasoning_tokens,
     u.cost_usd, ${text} AS prompt_text, u.session_id, u.cwd,
     ${GROUP_KEY_SQL} AS group_key`;
}

interface PromptGroupHead {
  readonly group_key: string;
  readonly first_ts: number;
  readonly first_id: number;
}

/**
 * The prompt identity of a ledger row, computed in SQL so both queries
 * agree byte for byte. Rows without a key group by their words within a
 * session (the same words in two sessions are two prompts); rows with
 * neither stand alone. agent and model are folded in so the key is
 * global and a single IN list can fetch the members of many groups.
 */
const GROUP_KEY_SQL = `u.agent || '|' || u.model || '|' || CASE
     WHEN u.prompt_key IS NOT NULL THEN 'key:' || u.prompt_key
     WHEN u.prompt_text IS NOT NULL THEN 'text:' || COALESCE(u.session_id, '') || '|' || u.prompt_text
     ELSE 'row:' || u.id
   END`;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return PROMPTS_DEFAULT_LIMIT;
  }
  return Math.min(PROMPTS_MAX_LIMIT, Math.floor(limit));
}

interface FilterClause {
  readonly from: string;
  readonly where: string;
  readonly binds: readonly (string | number)[];
}

function buildFilter(filter: PromptFilter, includeSearch: boolean): FilterClause {
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  const search = filter.search === null ? null : filter.search.trim();
  const searching = includeSearch && search !== null && search.length > 0;
  // the FTS table is the join driver only when there is something to match
  const from = searching ? 'prompt_fts f JOIN usage_ledger u ON u.id = f.rowid' : 'usage_ledger u';
  if (searching) {
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
  return { from, where: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`, binds };
}

function runQuery<T>(db: Database, sql: string, binds: readonly (string | number)[]): T[] {
  try {
    return db.query<T, (string | number)[]>(sql).all(...binds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('fts5')) {
      throw new FtsSyntaxError(`invalid search syntax: ${message}`);
    }
    throw error;
  }
}

/** Newest prompts first: one head per group, ordered by the prompt's first call. */
function selectGroupHeads(db: Database, filter: PromptFilter, limit: number): PromptGroupHead[] {
  const clause = buildFilter(filter, true);
  const sql = `SELECT ${GROUP_KEY_SQL} AS group_key, MIN(u.ts_utc) AS first_ts, MIN(u.id) AS first_id
     FROM ${clause.from} ${clause.where}
     GROUP BY group_key
     ORDER BY first_ts DESC, first_id DESC
     LIMIT ?`;
  return runQuery<PromptGroupHead>(db, sql, [...clause.binds, limit + 1]);
}

/**
 * Every call of the selected prompts, oldest first. The search filter is
 * deliberately dropped here: a prompt matched as a whole, so all of its
 * calls belong to it. `first_ts` bounds the scan — no member predates
 * its group's first call by definition.
 */
function selectGroupMembers(
  db: Database,
  filter: PromptFilter,
  heads: readonly PromptGroupHead[],
): PromptSqlRow[] {
  if (heads.length === 0) {
    return [];
  }
  const clause = buildFilter(filter, false);
  const oldestFirstTs = Math.min(...heads.map((head) => head.first_ts));
  const membership = `${GROUP_KEY_SQL} IN (SELECT value FROM json_each(?))`;
  const where = clause.where.length === 0
    ? `WHERE u.ts_utc >= ? AND ${membership}`
    : `${clause.where} AND u.ts_utc >= ? AND ${membership}`;
  const sql = `SELECT ${memberColumns(PROMPT_TEXT_LIMIT)}
     FROM ${clause.from} ${where}
     ORDER BY u.ts_utc ASC, u.id ASC`;
  const keys = JSON.stringify(heads.map((head) => head.group_key));
  return runQuery<PromptSqlRow>(db, sql, [...clause.binds, oldestFirstTs, keys]);
}

/** Every call of the prompt that call `id` belongs to, oldest first, with full text. */
function selectPromptCalls(db: Database, id: number): PromptSqlRow[] {
  const keyRow = db
    .query<{ group_key: string }, [number]>(
      `SELECT ${GROUP_KEY_SQL} AS group_key FROM usage_ledger u WHERE u.id = ?`,
    )
    .get(id);
  if (keyRow === null) {
    return [];
  }
  const sql = `SELECT ${memberColumns(null)}
     FROM usage_ledger u
     WHERE ${GROUP_KEY_SQL} = ?
     ORDER BY u.ts_utc ASC, u.id ASC`;
  return runQuery<PromptSqlRow>(db, sql, [keyRow.group_key]);
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
  let heads: PromptGroupHead[];
  let members: PromptSqlRow[];
  let truncated = false;
  try {
    const fetched = selectGroupHeads(db, request, limit);
    truncated = fetched.length > limit;
    heads = truncated ? fetched.slice(0, limit) : fetched;
    members = selectGroupMembers(db, request, heads);
  } finally {
    db.close();
  }

  const pricing = await loadPricing({
    needed: uniqueModels(members),
    allowRefresh: request.noRefresh !== true,
    fetchFn: deps.fetchFn,
    cacheDir: deps.cacheDir,
    configPath: deps.configPath,
    nowUtc: deps.nowUtc,
  });
  const billing = loadBillingOverrides(deps.configPath ?? defaultConfigPath());

  const groups = foldIntoPrompts(members, pricing, billing.overrides);
  return {
    // heads carry the display order; a head with no members (a row that
    // vanished between the two queries) is simply absent
    rows: heads.flatMap((head) => {
      const group = groups.get(head.group_key);
      return group === undefined ? [] : [group];
    }),
    truncated,
    warnings: [...pricing.warnings, ...billing.warnings],
  };
}

/** One API call inside a prompt, as the detail view lists them. */
export interface PromptCall {
  readonly id: number;
  readonly tsUtc: number;
  readonly model: string;
  readonly effort: string | null;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
}

export interface PromptDetail {
  /** The prompt with its full text and totals over every call. */
  readonly prompt: PromptRow;
  readonly provider: string | null;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  /** When the last call happened; equals prompt.tsUtc for a single call. */
  readonly lastTsUtc: number;
  readonly calls: readonly PromptCall[];
  readonly warnings: readonly string[];
}

export interface PromptDetailRequest {
  readonly databasePath: string;
  /** Ledger id of any call of the prompt (the list hands out the first). */
  readonly id: number;
  readonly noRefresh?: boolean;
}

/**
 * Everything about one prompt: the full body (the list clips it) and
 * every call it produced, priced one by one. Null when the id is gone —
 * a compaction or a retention pass can remove a row between the list
 * and the detail.
 */
export async function loadPromptDetail(
  request: PromptDetailRequest,
  deps: PromptListDeps = {},
): Promise<PromptDetail | null> {
  const db = openReadOnlyDatabase(request.databasePath, LATEST_SCHEMA_VERSION);
  let members: PromptSqlRow[];
  try {
    members = selectPromptCalls(db, request.id);
  } finally {
    db.close();
  }
  const first = members[0];
  if (first === undefined) {
    return null;
  }
  const pricing = await loadPricing({
    needed: uniqueModels(members),
    allowRefresh: request.noRefresh !== true,
    fetchFn: deps.fetchFn,
    cacheDir: deps.cacheDir,
    configPath: deps.configPath,
    nowUtc: deps.nowUtc,
  });
  const billing = loadBillingOverrides(deps.configPath ?? defaultConfigPath());
  const calls = members.map((row) => toCallRow(row, pricing, billing.overrides));
  const prompt = calls.slice(1).reduce(mergeCall, calls[0]!);
  return {
    prompt,
    provider: first.provider,
    sessionId: first.session_id,
    cwd: first.cwd,
    lastTsUtc: members[members.length - 1]?.ts_utc ?? first.ts_utc,
    calls: calls.map((call) => ({
      id: call.id,
      tsUtc: call.tsUtc,
      model: call.model,
      effort: call.effort,
      tokens: call.tokens,
      costUsd: call.costUsd,
    })),
    warnings: [...pricing.warnings, ...billing.warnings],
  };
}

function uniqueModels(rows: readonly PromptSqlRow[]): NeededModel[] {
  const byKey = new Map<string, NeededModel>();
  for (const row of rows) {
    byKey.set(pricingKey(row.agent, row.provider, row.model), {
      agent: row.agent,
      provider: row.provider,
      model: row.model,
    });
  }
  return [...byKey.values()];
}

function toCallRow(row: PromptSqlRow, pricing: LoadedPricing, overrides: BillingOverrides): PromptRow {
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
    nature: billingNature(row.agent, row.provider, overrides),
    costUsd: isSourceAuthoritative(row.agent) ? row.cost_usd : listPriceFor(row, tokens, pricing),
    text: row.prompt_text ?? '',
    calls: 1,
    isSidechain: row.is_sidechain === 1,
  };
}

/** Members arrive oldest first, so the first row seen is the prompt's first call. */
function foldIntoPrompts(
  members: readonly PromptSqlRow[],
  pricing: LoadedPricing,
  overrides: BillingOverrides,
): Map<string, PromptRow> {
  const groups = new Map<string, PromptRow>();
  for (const member of members) {
    const call = toCallRow(member, pricing, overrides);
    const existing = groups.get(member.group_key);
    groups.set(member.group_key, existing === undefined ? call : mergeCall(existing, call));
  }
  return groups;
}

function mergeCall(prompt: PromptRow, call: PromptRow): PromptRow {
  return {
    ...prompt,
    // the words come from whichever call has them: an early call can
    // predate the prompt's own text (unresolved chain), a later one not
    text: prompt.text.length > 0 ? prompt.text : call.text,
    tokens: addTokens(prompt.tokens, call.tokens),
    costUsd: prompt.costUsd === null || call.costUsd === null ? null : prompt.costUsd + call.costUsd,
    calls: prompt.calls + call.calls,
  };
}

function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** loadPricing already resolved every model we asked about. */
function listPriceFor(
  row: PromptSqlRow,
  tokens: TokenTotals,
  pricing: LoadedPricing,
): number | null {
  const resolution = pricing.resolutions.get(pricingKey(row.agent, row.provider, row.model));
  if (resolution === undefined || resolution.status !== 'resolved') {
    return null;
  }
  const outcome = listPriceUsdFor(
    row.agent,
    tokens,
    selectTierRates(resolution.record, tokens.inputTokens),
  );
  return outcome.ok ? outcome.usd : null;
}
