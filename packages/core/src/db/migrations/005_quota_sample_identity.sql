-- 005_quota_sample_identity.sql
-- Fold account_id into the sample identity. Two accounts can share a
-- display label (personal + organization on one email), and readings
-- taken in the same load share one observed_at second — without the id
-- in the unique key one of them silently loses its history to
-- INSERT OR IGNORE. account_id is '' (not NULL) when unknown so the
-- uniqueness actually holds (SQLite treats NULLs as pairwise distinct).

CREATE TABLE quota_samples_new (
  id               INTEGER PRIMARY KEY,
  agent            TEXT NOT NULL,
  account          TEXT NOT NULL DEFAULT '',
  account_id       TEXT NOT NULL DEFAULT '',
  window_id        TEXT NOT NULL,
  used_percent     REAL NOT NULL,
  resets_at_utc    INTEGER,
  source           TEXT NOT NULL,
  observed_at_utc  INTEGER NOT NULL,
  recorded_at_utc  INTEGER NOT NULL,
  UNIQUE (agent, account, account_id, window_id, observed_at_utc)
);

INSERT INTO quota_samples_new
  (id, agent, account, account_id, window_id, used_percent, resets_at_utc,
   source, observed_at_utc, recorded_at_utc)
SELECT id, agent, account, COALESCE(account_id, ''), window_id, used_percent,
       resets_at_utc, source, observed_at_utc, recorded_at_utc
FROM quota_samples;

DROP TABLE quota_samples;
ALTER TABLE quota_samples_new RENAME TO quota_samples;

CREATE INDEX IF NOT EXISTS idx_quota_samples_agent_time
  ON quota_samples (agent, account, observed_at_utc);

CREATE INDEX IF NOT EXISTS idx_quota_samples_account_id
  ON quota_samples (agent, account_id, observed_at_utc);
