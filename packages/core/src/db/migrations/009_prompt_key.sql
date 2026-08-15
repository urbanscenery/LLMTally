-- 009_prompt_key.sql
-- Applied atomically by migrate.ts inside BEGIN IMMEDIATE / COMMIT.
--
-- One ledger row is one API call, and a single prompt fans out into many
-- calls (every tool round-trip is a new call). Until now the only way to
-- fold those calls back into the prompt that produced them was the prompt
-- text itself, which is lossy (the same words typed twice merge; aged-out
-- text cannot be grouped at all). prompt_key carries the source's own
-- prompt identity (Claude user uuid, codex turn id, opencode user message
-- id, grok prompt id, antigravity step index) so reports can group calls
-- per prompt exactly. Nullable: rows whose source log is gone keep NULL
-- and fall back to text grouping.
--
-- Every parser gained the key together with prompt-attribution fixes
-- (sidechain chains, codex compaction, antigravity prompt decoding), so
-- the scan cursors are dropped: the next collection rescans every source
-- from the start and the natural-key upsert rewrites prompt_text /
-- prompt_key on rows whose parser_version increased. Rows themselves are
-- kept — sources with a short shelf life (Claude Code deletes transcripts
-- after ~30 days) would otherwise lose history the ledger already has.

ALTER TABLE usage_ledger ADD COLUMN prompt_key TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_ledger_prompt_key
  ON usage_ledger (agent, prompt_key)
  WHERE prompt_key IS NOT NULL;

DELETE FROM scan_state;
