import type { Database } from 'bun:sqlite';

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'data'],
};

/**
 * Completed assistants join their prompt through data.parentID -> user
 * message -> part rows in one statement. json_valid guards keep a single
 * corrupted row from failing the whole SELECT: invalid candidates are
 * returned so the caller can surface a warning per row.
 */
const COLLECT_SQL = `SELECT
  a.id           AS assistantId,
  a.session_id   AS assistantSessionId,
  a.time_updated AS assistantTimeUpdated,
  a.data         AS assistantData,
  u.id           AS userId,
  p.id           AS partId,
  p.data         AS partData
FROM message AS a
LEFT JOIN message AS u
  ON u.id = CASE
    WHEN json_valid(a.data) THEN json_extract(a.data, '$.parentID')
    ELSE NULL
  END
LEFT JOIN part AS p
  ON p.message_id = u.id
WHERE a.time_updated >= ?
  AND CASE
    WHEN json_valid(a.data) = 0 THEN 1
    WHEN json_extract(a.data, '$.role') = 'assistant'
      AND json_extract(a.data, '$.time.completed') IS NOT NULL
    THEN 1
    ELSE 0
  END = 1
ORDER BY a.time_updated, a.id, p.id`;

export interface OpenCodeJoinedRow {
  readonly assistantId: string;
  readonly assistantSessionId: string | null;
  readonly assistantTimeUpdated: number;
  readonly assistantData: string;
  readonly userId: string | null;
  readonly partId: string | null;
  readonly partData: string | null;
}

export function validateOpenCodeSchema(db: Database): string | null {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = db
      .query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?)')
      .all(table)
      .map((row) => row.name);
    if (columns.length === 0) {
      return `source table "${table}" is missing`;
    }
    for (const column of requiredColumns) {
      if (!columns.includes(column)) {
        return `source table "${table}" is missing column "${column}"`;
      }
    }
  }
  return null;
}

export function fetchJoinedRows(db: Database, sinceUpdatedMs: number): OpenCodeJoinedRow[] {
  return db.query<OpenCodeJoinedRow, [number]>(COLLECT_SQL).all(sinceUpdatedMs);
}
