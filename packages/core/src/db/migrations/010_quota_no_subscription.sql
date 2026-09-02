-- 010_quota_no_subscription.sql
-- Remembers that a budget key's account has no paid subscription any
-- more (the usage endpoint refuses free accounts with 429/403 forever),
-- so the verdict outlives the process that observed it: a deferred read
-- in any process shows "free plan" instead of retrying a wait that
-- cannot end, and stored history is not re-served for a plan that
-- ended. Cleared by the next successful read (resubscription) or by a
-- refusal whose profile probe finds the account paid again.

ALTER TABLE quota_fetch_state
  ADD COLUMN no_subscription_at_utc INTEGER
  CHECK (no_subscription_at_utc IS NULL OR no_subscription_at_utc >= 0);
