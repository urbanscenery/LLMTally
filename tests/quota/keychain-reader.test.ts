import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultClaudeTokenReader } from '@llmtally/core/quota/providers.ts';
import { createMemoryKeychain } from '@llmtally/core/accounts/keychain.ts';
import { makeTempDir } from '../helpers.ts';

test('quota reader does not replace an unreadable keychain credential with a stale file', () => {
  const home = makeTempDir();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stale' } }));
  const keychain = {
    ...createMemoryKeychain(),
    read: () => ({ kind: 'error' as const, message: 'approval required', requiresInteraction: true }),
  };
  const read = defaultClaudeTokenReader(home, keychain);
  expect(read()).toBeNull();
});
