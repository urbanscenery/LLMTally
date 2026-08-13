-- 008_claude_message_dedup.sql
-- Applied atomically by migrate.ts inside BEGIN IMMEDIATE / COMMIT.
--
-- Parser v1 keyed claude-code entries by the JSONL line uuid, but Claude
-- Code writes one line per content block of the same assistant message
-- with the usage block copied onto each line — so a single API call was
-- ledgered once per block (~2-3x token overcount). Parser v2 keys by the
-- API message id instead. The v1 rows cannot be deduplicated in place
-- (they never stored the message id), so drop them together with the
-- claude-code scan cursors; the next collection run performs a full
-- rescan of the source logs, which is always safe by design.

DELETE FROM usage_ledger WHERE agent = 'claude-code';
DELETE FROM scan_state WHERE agent = 'claude-code';
