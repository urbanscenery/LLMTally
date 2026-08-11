-- 004_quota_sample_account_id.sql
-- Stable account identity on quota history. Rows recorded before this
-- migration carry NULL and are matched by their display label instead,
-- so history written under an old email label is still reachable.

ALTER TABLE quota_samples ADD COLUMN account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_quota_samples_account_id
  ON quota_samples (agent, account_id, observed_at_utc);
