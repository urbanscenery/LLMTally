import type { Database, Statement } from 'bun:sqlite';

import type { JsonObject, LedgerEntry } from '../domain/types.ts';
import type {
  CommitBatchInput,
  CommitBatchResult,
  LedgerRepository,
  StoredScanState,
} from '../scan/types.ts';
import { migrate } from './migrate.ts';

// Natural-key duplicates are normally skipped (any other constraint
// violation aborts the batch), with one carve-out: a duplicate carrying a
// LARGER output count refreshes the token columns. Claude Code duplicates
// the usage block across the JSONL lines of one assistant message, and
// while the message is still streaming those copies are cumulative
// snapshots — the last one is what the API actually billed. Only token
// columns are updated: prompt_text must stay untouched so agePrompts
// redactions survive rescans. For sources whose duplicates are exact
// copies the WHERE guard never fires, so this stays a plain skip.
const INSERT_ENTRY_SQL = `INSERT INTO usage_ledger
  (ts_utc, agent, account, provider, model, effort, prompt_text,
   input_tokens, output_tokens, cache_write, cache_read, reasoning_tokens,
   cost_usd, session_id, cwd, natural_id, parser_version, is_sidechain, parent_uuid)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (agent, natural_id) DO UPDATE SET
   input_tokens = excluded.input_tokens,
   output_tokens = excluded.output_tokens,
   cache_write = excluded.cache_write,
   cache_read = excluded.cache_read
 WHERE excluded.output_tokens > usage_ledger.output_tokens
 RETURNING id`;

const UPSERT_SCAN_STATE_SQL = `INSERT INTO scan_state
  (agent, path, mtime, size, last_offset, cursor_json)
 VALUES (?, ?, ?, ?, ?, ?)
 ON CONFLICT (agent, path) DO UPDATE SET
   mtime = excluded.mtime,
   size = excluded.size,
   last_offset = excluded.last_offset,
   cursor_json = excluded.cursor_json`;

interface ScanStateRow {
  readonly agent: string;
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
  readonly last_offset: number;
  readonly cursor_json: string;
}

export class RepositoryError extends Error {
  override readonly name = 'RepositoryError';
}

export class SqliteLedgerRepository implements LedgerRepository {
  readonly #db: Database;
  #insertEntry: Statement | null = null;
  #upsertScanState: Statement | null = null;

  constructor(db: Database) {
    this.#db = db;
  }

  migrate(): void {
    migrate(this.#db);
  }

  /**
   * Ages out prompt text observed before the cutoff. Only the words go:
   * `prompt_text` becomes NULL (the AU trigger removes the FTS entry in
   * the same statement) while tokens, model, cost, and timing stay
   * forever. Re-scanning an old source cannot resurrect the text — the
   * natural-key conflict clause never writes prompt_text on a duplicate.
   */
  agePrompts(cutoffUtc: number): number {
    // count first, in the same transaction: the changes counter is
    // inflated by the FTS triggers (see commitBatch)
    const run = this.#db.transaction((): number => {
      const eligible = this.#db
        .query<{ n: number }, [number]>(
          'SELECT COUNT(*) AS n FROM usage_ledger WHERE ts_utc < ? AND prompt_text IS NOT NULL',
        )
        .get(cutoffUtc);
      if (eligible === null || eligible.n === 0) {
        return 0;
      }
      this.#db.run(
        'UPDATE usage_ledger SET prompt_text = NULL WHERE ts_utc < ? AND prompt_text IS NOT NULL',
        [cutoffUtc],
      );
      return eligible.n;
    });
    return run();
  }

  /**
   * Inserts a batch of entries and advances the source cursor in one
   * transaction so a crash can never persist rows without their offset
   * (or the other way round). Duplicate natural ids are counted as
   * ignored, which is the expected outcome of a rescan.
   */
  commitBatch(input: CommitBatchInput): CommitBatchResult {
    const { target, batch } = input;
    const insertEntry = this.#prepareInsertEntry();
    const upsertScanState = this.#prepareUpsertScanState();

    const runCommit = this.#db.transaction(() => {
      let inserted = 0;
      for (const entry of batch.entries) {
        // RETURNING id yields a row for real inserts and for the rare
        // token-refresh update (both advanced the ledger); exact-duplicate
        // skips return nothing. The changes counter is unreliable here
        // because the FTS triggers inflate it.
        inserted += insertEntry.get(...entryParams(entry)) === null ? 0 : 1;
      }
      if (batch.nextOffset !== null) {
        upsertScanState.run(
          target.agent,
          target.path,
          batch.sourceMtime ?? 0,
          batch.sourceSize ?? 0,
          batch.nextOffset,
          JSON.stringify(batch.nextCursor),
        );
      }
      return inserted;
    });

    const insertedRows = runCommit();
    return {
      insertedRows,
      ignoredRows: batch.entries.length - insertedRows,
      committedOffset: batch.nextOffset,
    };
  }

  #prepareInsertEntry(): Statement {
    this.#insertEntry ??= this.#db.prepare(INSERT_ENTRY_SQL);
    return this.#insertEntry;
  }

  #prepareUpsertScanState(): Statement {
    this.#upsertScanState ??= this.#db.prepare(UPSERT_SCAN_STATE_SQL);
    return this.#upsertScanState;
  }

  getScanState(agent: string, path: string): StoredScanState | null {
    const row = this.#db
      .query<ScanStateRow, [string, string]>(
        'SELECT agent, path, mtime, size, last_offset, cursor_json FROM scan_state WHERE agent = ? AND path = ?',
      )
      .get(agent, path);
    if (row === null) {
      return null;
    }
    return {
      agent: row.agent,
      path: row.path,
      mtime: row.mtime,
      size: row.size,
      lastOffset: row.last_offset,
      cursorJson: parseCursor(row.cursor_json, agent, path),
    };
  }

  close(): void {
    this.#db.close();
  }
}

function entryParams(entry: LedgerEntry): readonly (string | number | null)[] {
  return [
    entry.tsUtc,
    entry.agent,
    entry.account,
    entry.provider,
    entry.model,
    entry.effort,
    entry.promptText,
    entry.inputTokens,
    entry.outputTokens,
    entry.cacheWrite,
    entry.cacheRead,
    entry.reasoningTokens,
    entry.costUsd,
    entry.sessionId,
    entry.cwd,
    entry.naturalId,
    entry.parserVersion,
    entry.isSidechain ? 1 : 0,
    entry.parentUuid,
  ];
}

function parseCursor(raw: string, agent: string, path: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RepositoryError(`scan_state.cursor_json for ${agent}:${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RepositoryError(`scan_state.cursor_json for ${agent}:${path} is not a JSON object`);
  }
  return parsed as JsonObject;
}
