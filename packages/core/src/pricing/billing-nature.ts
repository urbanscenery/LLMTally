/**
 * Billing nature — the settlement axis of a ledger row: does the usage
 * consume a subscription quota (its dollars are a list-price valuation)
 * or does it spend real money (card / prepaid credit)?
 *
 * This is deliberately separate from token/price provenance
 * (`isSourceAuthoritative`): who stamped the number says nothing about
 * whether the number was ever billed. See
 * local_docs/costs/2026-08-14-billing-nature-plan.md.
 *
 * The default table encodes what has been measured on real ledgers;
 * anything unlisted is `unknown` — never guessed into a total. Users
 * whose setup differs (e.g. Claude Code on an API key) flip it via
 * `billing.overrides` in ~/.llmtally/config.json.
 */
import { readFileSync } from 'node:fs';

import { asObject } from '../parsers/shared.ts';

export type BillingNature = 'quota' | 'spend' | 'unknown';

/** Override values may assert a nature, never un-know one. */
export type BillingOverrideNature = Exclude<BillingNature, 'unknown'>;

export type BillingOverrides = ReadonlyMap<string, BillingOverrideNature>;

/** Agents whose every provider is subscription/quota-settled. */
const QUOTA_AGENTS: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'antigravity-cli',
  'grok',
]);

/** Per-provider quota products (measured; see costs docs). */
const QUOTA_PROVIDERS: Readonly<Record<string, ReadonlySet<string>>> = {
  opencode: new Set(['opencode-go', 'cline-pass']),
  cline: new Set(['cline-pass']),
  // native grok-4 / composer models only; third-party stays unknown
  'cursor-cli': new Set(['cursor']),
};

/**
 * Spend allowlist is intentionally empty: no (agent, provider) pair has
 * been measured as card/credit-settled yet. Grow it from evidence, or
 * let users assert their own setup via overrides.
 */
const SPEND_PROVIDERS: Readonly<Record<string, ReadonlySet<string>>> = {};

export function overrideKey(agent: string, provider: string | null): string {
  return `${agent}/${provider ?? ''}`;
}

export function billingNature(
  agent: string,
  provider: string | null,
  overrides?: BillingOverrides,
): BillingNature {
  if (overrides !== undefined) {
    const exact = overrides.get(overrideKey(agent, provider));
    if (exact !== undefined) {
      return exact;
    }
    const wildcard = overrides.get(`${agent}/*`);
    if (wildcard !== undefined) {
      return wildcard;
    }
  }
  if (QUOTA_AGENTS.has(agent)) {
    return 'quota';
  }
  if (provider !== null && QUOTA_PROVIDERS[agent]?.has(provider) === true) {
    return 'quota';
  }
  if (provider !== null && SPEND_PROVIDERS[agent]?.has(provider) === true) {
    return 'spend';
  }
  return 'unknown';
}

export interface ParsedBillingOverrides {
  readonly overrides: BillingOverrides;
  readonly warnings: readonly string[];
}

const NO_OVERRIDES: ParsedBillingOverrides = { overrides: new Map(), warnings: [] };

/**
 * Extracts `billing.overrides` from a parsed config root. Invalid
 * entries are skipped with a warning — a typo must never silently
 * reclassify money, and must never break the report either.
 */
export function parseBillingOverrides(
  root: Record<string, unknown> | null,
): ParsedBillingOverrides {
  if (root === null || !('billing' in root)) {
    return NO_OVERRIDES;
  }
  const billing = asObject(root.billing);
  if (billing === null) {
    return { overrides: new Map(), warnings: ['billing section in config.json is not an object'] };
  }
  const rawOverrides = asObject(billing.overrides);
  if (rawOverrides === null) {
    return billing.overrides === undefined
      ? NO_OVERRIDES
      : { overrides: new Map(), warnings: ['billing.overrides in config.json is not an object'] };
  }
  const overrides = new Map<string, BillingOverrideNature>();
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(rawOverrides)) {
    if (!key.includes('/')) {
      warnings.push(`billing.overrides key "${key}" is not <agent>/<provider>; ignored`);
      continue;
    }
    if (value !== 'quota' && value !== 'spend') {
      warnings.push(`billing.overrides["${key}"] must be "quota" or "spend"; ignored`);
      continue;
    }
    overrides.set(key, value);
  }
  return { overrides, warnings };
}

/**
 * Reads overrides from the shared config file. Missing or unreadable
 * config degrades to defaults — billing classification is a lens, not
 * a requirement.
 */
export function loadBillingOverrides(configPath: string): ParsedBillingOverrides {
  let root: Record<string, unknown> | null;
  try {
    root = asObject(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return NO_OVERRIDES;
  }
  return parseBillingOverrides(root);
}
