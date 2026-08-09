-- 002_accounts.sql
-- Account registry (discovery only — never used to backfill ledger rows)
-- and quota sample history for sparklines / stored-lastGood fallback.

CREATE TABLE IF NOT EXISTS account_profiles (
  agent            TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  display_label    TEXT,
  email            TEXT,
  organization_id  TEXT,
  discovered_via   TEXT NOT NULL,
  first_seen_utc   INTEGER NOT NULL,
  last_seen_utc    INTEGER NOT NULL,
  PRIMARY KEY (agent, account_id)
);

CREATE TABLE IF NOT EXISTS quota_samples (
  id               INTEGER PRIMARY KEY,
  agent            TEXT NOT NULL,
  account          TEXT NOT NULL DEFAULT '',
  window_id        TEXT NOT NULL,
  used_percent     REAL NOT NULL,
  resets_at_utc    INTEGER,
  source           TEXT NOT NULL,
  observed_at_utc  INTEGER NOT NULL,
  recorded_at_utc  INTEGER NOT NULL,
  UNIQUE (agent, account, window_id, observed_at_utc)
);

CREATE INDEX IF NOT EXISTS idx_quota_samples_agent_time
  ON quota_samples (agent, account, observed_at_utc);
