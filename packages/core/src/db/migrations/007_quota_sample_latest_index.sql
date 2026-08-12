-- The stored last-good lookup asks "newest observation per window for
-- one agent/account". Neither existing index orders by window, so the
-- correlated-MAX form re-scanned the account's whole history once per
-- row — O(Q^2), measured 1.3s p95 at 40k samples (delta review D-03).
-- Ordering (…, window_id, observed_at_utc DESC) lets the rewritten
-- window-function query stream each window's rows newest-first and
-- stop at the first one.
CREATE INDEX IF NOT EXISTS idx_quota_samples_latest_by_id
  ON quota_samples (agent, account_id, window_id, observed_at_utc DESC);

-- Label-keyed variant of the same lookup, for callers without an id.
CREATE INDEX IF NOT EXISTS idx_quota_samples_latest_by_label
  ON quota_samples (agent, account, window_id, observed_at_utc DESC);
