-- 001_initial.sql
-- Applied atomically by migrate.ts inside BEGIN IMMEDIATE / COMMIT.

CREATE TABLE IF NOT EXISTS usage_ledger (
  id                INTEGER PRIMARY KEY,
  ts_utc            INTEGER NOT NULL,
  agent             TEXT NOT NULL,
  account           TEXT,
  provider          TEXT,
  model             TEXT NOT NULL,
  effort            TEXT,
  prompt_text       TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write       INTEGER NOT NULL DEFAULT 0,
  cache_read        INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL,
  session_id        TEXT,
  cwd               TEXT,
  natural_id        TEXT NOT NULL,
  parser_version    INTEGER NOT NULL,
  is_sidechain      INTEGER NOT NULL DEFAULT 0
                    CHECK (is_sidechain IN (0, 1)),
  parent_uuid       TEXT,
  UNIQUE (agent, natural_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_ts
  ON usage_ledger (ts_utc);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_agent_ts
  ON usage_ledger (agent, ts_utc);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_model
  ON usage_ledger (model);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_parent_uuid
  ON usage_ledger (parent_uuid)
  WHERE parent_uuid IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS prompt_fts USING fts5(
  prompt_text,
  content = 'usage_ledger',
  content_rowid = 'id'
);

CREATE TRIGGER IF NOT EXISTS usage_ledger_ai
AFTER INSERT ON usage_ledger
BEGIN
  INSERT INTO prompt_fts (rowid, prompt_text)
  VALUES (new.id, COALESCE(new.prompt_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS usage_ledger_ad
AFTER DELETE ON usage_ledger
BEGIN
  INSERT INTO prompt_fts (prompt_fts, rowid, prompt_text)
  VALUES ('delete', old.id, COALESCE(old.prompt_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS usage_ledger_au
AFTER UPDATE ON usage_ledger
BEGIN
  INSERT INTO prompt_fts (prompt_fts, rowid, prompt_text)
  VALUES ('delete', old.id, COALESCE(old.prompt_text, ''));
  INSERT INTO prompt_fts (rowid, prompt_text)
  VALUES (new.id, COALESCE(new.prompt_text, ''));
END;

CREATE TABLE IF NOT EXISTS scan_state (
  agent        TEXT NOT NULL,
  path         TEXT NOT NULL,
  mtime        INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  last_offset  INTEGER NOT NULL DEFAULT 0,
  cursor_json  TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (agent, path)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value)
VALUES
  ('schema_version', '1'),
  ('migration_id', '001_initial'),
  ('fts_schema_version', '1'),
  ('created_at_utc', CAST(strftime('%s', 'now') AS TEXT));
