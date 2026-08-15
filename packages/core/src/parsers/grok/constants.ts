export const GROK_AGENT = 'grok';
export const GROK_PARSER_VERSION = 2;
export const GROK_CURSOR_VERSION = 1;
/** Grok Build talks to xAI through cli-chat-proxy.grok.com. */
export const GROK_PROVIDER = 'xai';
export const GROK_UNKNOWN_MODEL = 'unknown';

/** The only per-session file that carries usage; the siblings are transcripts. */
export const GROK_UPDATES_FILE = 'updates.jsonl';
export const GROK_SUMMARY_FILE = 'summary.json';

/**
 * `costUsdTicks` is fixed-point USD. Solving three measured turns for the
 * per-token rate yields exactly 20000 / 5000 / 60000 ticks for uncached
 * input / cached read / output — i.e. xAI's list $2.00 / $0.50 / $6.00 per
 * 1M tokens at 1e10 ticks to the dollar.
 */
export const GROK_COST_TICKS_PER_USD = 10_000_000_000;
