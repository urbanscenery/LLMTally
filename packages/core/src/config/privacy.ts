/**
 * Privacy policy knobs from `~/.llmtally/config.json` (`privacy`
 * section). Decided 2026-08-13 (audit D-06/R-11): prompt TEXT ages out
 * after a year by default — the ledger keeps every row's tokens, model,
 * and cost forever, but the words themselves are the sensitive part and
 * they were measured at ~70% of the database. `promptRetentionDays: 0`
 * opts out and keeps text forever (the full-archive stance).
 *
 * Like the UI preferences, an unreadable or malformed file must never
 * break a scan: it just means defaults.
 */
import { readFileSync } from 'node:fs';

import { asObject } from '../parsers/shared.ts';
import { defaultPreferencesPath } from './preferences.ts';

export const DEFAULT_PROMPT_RETENTION_DAYS = 365;

export interface PrivacyConfig {
  /** Days prompt text is kept; 0 = forever. Aggregates are never aged. */
  readonly promptRetentionDays: number;
}

export function loadPrivacyConfig(path: string = defaultPreferencesPath()): PrivacyConfig {
  let root: Record<string, unknown> | null = null;
  try {
    root = asObject(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    root = null;
  }
  const privacy = root === null ? null : asObject(root.privacy);
  const days = privacy?.promptRetentionDays;
  return {
    promptRetentionDays:
      typeof days === 'number' && Number.isFinite(days) && days >= 0
        ? Math.floor(days)
        : DEFAULT_PROMPT_RETENTION_DAYS,
  };
}
