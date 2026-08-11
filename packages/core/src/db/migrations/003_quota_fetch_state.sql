-- 003_quota_fetch_state.sql
-- Per-budget-key quota fetch state: cadence reservation, 429 backoff,
-- and the in-flight claim that makes the vendor request budget shared
-- across every llmtally process instead of per-process memory.
-- The key never contains a raw token (UA + sha256 prefix fingerprint).

CREATE TABLE IF NOT EXISTS quota_fetch_state (
  key                   TEXT PRIMARY KEY,
  agent                 TEXT NOT NULL,
  account_id            TEXT,
  account_label         TEXT,
  blocked_until_utc     INTEGER NOT NULL DEFAULT 0
                        CHECK (blocked_until_utc >= 0),
  consecutive_429       INTEGER NOT NULL DEFAULT 0
                        CHECK (consecutive_429 >= 0),
  last_429_utc          INTEGER
                        CHECK (last_429_utc IS NULL OR last_429_utc >= 0),
  last_fetch_utc        INTEGER NOT NULL DEFAULT 0
                        CHECK (last_fetch_utc >= 0),
  claim_owner           TEXT,
  claim_until_utc       INTEGER,
  updated_at_utc        INTEGER NOT NULL
                        CHECK (updated_at_utc >= 0),
  CHECK (
    (claim_owner IS NULL AND claim_until_utc IS NULL) OR
    (claim_owner IS NOT NULL AND claim_until_utc IS NOT NULL AND claim_until_utc >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_quota_fetch_state_updated
  ON quota_fetch_state (updated_at_utc);
