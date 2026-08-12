-- 006_quota_auth_state.sql
-- Remembers that a budget key's credential was refused by the vendor
-- (401/403), so the refusal outlives the process that observed it.
--
-- Without this, the next read inside the polling cadence comes back
-- "deferred" — an ordinary wait — and the stored-history fallback
-- happily re-serves the numbers the rejected credential had produced.
-- The mark is cleared by the next successful read, so re-logging in
-- restores normal behaviour with no further bookkeeping.

ALTER TABLE quota_fetch_state
  ADD COLUMN auth_invalid_at_utc INTEGER
  CHECK (auth_invalid_at_utc IS NULL OR auth_invalid_at_utc >= 0);
