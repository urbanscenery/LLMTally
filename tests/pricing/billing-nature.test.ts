import { describe, expect, test } from 'bun:test';

import { AGENT_TOKEN_SEMANTICS } from '@llmtally/core/pricing/types.ts';
import {
  billingNature,
  parseBillingOverrides,
} from '@llmtally/core/pricing/billing-nature.ts';

describe('billingNature defaults', () => {
  test('classifies subscription agents as quota regardless of provider', () => {
    expect(billingNature('claude-code', 'anthropic')).toBe('quota');
    expect(billingNature('codex', 'openai')).toBe('quota');
    expect(billingNature('antigravity-cli', 'google')).toBe('quota');
    expect(billingNature('grok', 'xai')).toBe('quota');
  });

  test('classifies known quota providers for opencode and cline', () => {
    expect(billingNature('opencode', 'opencode-go')).toBe('quota');
    expect(billingNature('opencode', 'cline-pass')).toBe('quota');
    expect(billingNature('cline', 'cline-pass')).toBe('quota');
  });

  test('classifies native cursor-cli models as quota and third-party as unknown', () => {
    expect(billingNature('cursor-cli', 'cursor')).toBe('quota');
    expect(billingNature('cursor-cli', 'anthropic')).toBe('unknown');
    expect(billingNature('cursor-cli', null)).toBe('unknown');
  });

  test('returns unknown for unlisted providers instead of guessing', () => {
    expect(billingNature('opencode', 'anthropic')).toBe('unknown');
    expect(billingNature('opencode', 'openrouter')).toBe('unknown');
    expect(billingNature('cline', 'openrouter')).toBe('unknown');
  });

  test('returns unknown for unknown agents and null providers', () => {
    expect(billingNature('mystery-agent', 'anthropic')).toBe('unknown');
    expect(billingNature('opencode', null)).toBe('unknown');
  });

  test('cursor-cli uses claude_separate_cache token semantics', () => {
    expect(AGENT_TOKEN_SEMANTICS['cursor-cli']).toEqual({
      version: 1,
      formula: 'claude_separate_cache',
    });
  });
});

describe('billingNature overrides', () => {
  test('exact agent/provider override wins over the default table', () => {
    const overrides = new Map([['claude-code/anthropic', 'spend' as const]]);
    expect(billingNature('claude-code', 'anthropic', overrides)).toBe('spend');
    // other agents keep their defaults
    expect(billingNature('codex', 'openai', overrides)).toBe('quota');
  });

  test('agent wildcard override applies to every provider of that agent', () => {
    const overrides = new Map([['claude-code/*', 'spend' as const]]);
    expect(billingNature('claude-code', 'anthropic', overrides)).toBe('spend');
  });

  test('exact override wins over wildcard', () => {
    const overrides = new Map([
      ['opencode/*', 'spend' as const],
      ['opencode/opencode-go', 'quota' as const],
    ]);
    expect(billingNature('opencode', 'opencode-go', overrides)).toBe('quota');
    expect(billingNature('opencode', 'openrouter', overrides)).toBe('spend');
  });

  test('override can promote an unknown provider to spend', () => {
    const overrides = new Map([['opencode/openrouter', 'spend' as const]]);
    expect(billingNature('opencode', 'openrouter', overrides)).toBe('spend');
  });
});

describe('parseBillingOverrides', () => {
  test('reads billing.overrides entries from a config root', () => {
    const { overrides, warnings } = parseBillingOverrides({
      billing: { overrides: { 'claude-code/anthropic': 'spend' } },
    });
    expect(overrides.get('claude-code/anthropic')).toBe('spend');
    expect(warnings).toEqual([]);
  });

  test('missing billing section yields empty overrides without warnings', () => {
    expect(parseBillingOverrides({}).overrides.size).toBe(0);
    expect(parseBillingOverrides(null).overrides.size).toBe(0);
    expect(parseBillingOverrides(null).warnings).toEqual([]);
  });

  test('invalid values are skipped with a warning, valid ones survive', () => {
    const { overrides, warnings } = parseBillingOverrides({
      billing: {
        overrides: {
          'claude-code/anthropic': 'billed', // not a valid nature
          'opencode/openrouter': 'spend',
          'no-slash-key': 'spend',
        },
      },
    });
    expect(overrides.get('opencode/openrouter')).toBe('spend');
    expect(overrides.has('claude-code/anthropic')).toBe(false);
    expect(overrides.has('no-slash-key')).toBe(false);
    expect(warnings.length).toBe(2);
  });

  test('unknown is not accepted as an override value', () => {
    const { overrides, warnings } = parseBillingOverrides({
      billing: { overrides: { 'opencode/anthropic': 'unknown' } },
    });
    expect(overrides.size).toBe(0);
    expect(warnings.length).toBe(1);
  });

  test('malformed billing section is tolerated with a warning', () => {
    const { overrides, warnings } = parseBillingOverrides({ billing: 'yes' });
    expect(overrides.size).toBe(0);
    expect(warnings.length).toBe(1);
  });
});
