export const CODEX_AGENT = 'codex';
export const CODEX_PROVIDER_FALLBACK = 'openai';
// v2: natural id switched from turn ordinals (lost distinct usage on
// resumed rollouts) to usage content digests
// v3: prompt attribution — same-turn turn_context re-emits keep the
// prompt, `<skill>` expansions no longer overwrite it, subagent NEW_TASK
// mail counts as the prompt, and prompt_key (turn id) is recorded
export const CODEX_PARSER_VERSION = 3;
export const CODEX_CURSOR_VERSION = 1;
