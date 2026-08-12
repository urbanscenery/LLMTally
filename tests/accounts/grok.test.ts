import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverAccounts } from '@llmtally/core/accounts/discovery.ts';
import { readGrokIdentities } from '@llmtally/core/accounts/grok.ts';
import { makeTempDir } from '../helpers.ts';

function writeAuth(document: unknown): string {
  const path = join(makeTempDir(), 'auth.json');
  writeFileSync(path, JSON.stringify(document));
  return path;
}

const ACCOUNT = {
  key: 'eyJ0eXAiOiJhpretend.access.token',
  auth_mode: 'oidc',
  user_id: 'abc3a509-e881-4d18-9f1e-6a3f0b2c4d5e',
  email: 'dev@example.com',
  team_id: 'aa5ce99c-fd51-4a2b-9c8d-1e2f3a4b5c6d',
  refresh_token: 'pretend-refresh-token',
  oidc_issuer: 'https://auth.x.ai',
};

describe('readGrokIdentities', () => {
  test('reads the identity of every issuer entry, ignoring the secrets beside it', () => {
    // Arrange
    const path = writeAuth({
      'https://auth.x.ai::client-1': ACCOUNT,
      'https://auth.x.ai::client-2': { ...ACCOUNT, user_id: 'second-uuid', email: 'two@example.com' },
    });

    // Act
    const identities = readGrokIdentities(path);

    // Assert
    expect(identities).toEqual([
      {
        accountId: 'abc3a509-e881-4d18-9f1e-6a3f0b2c4d5e',
        email: 'dev@example.com',
        teamId: 'aa5ce99c-fd51-4a2b-9c8d-1e2f3a4b5c6d',
      },
      { accountId: 'second-uuid', email: 'two@example.com', teamId: ACCOUNT.team_id },
    ]);
    expect(JSON.stringify(identities)).not.toContain('pretend');
  });

  test('skips records with no user id rather than keying on the email', () => {
    // Arrange
    const path = writeAuth({ 'https://auth.x.ai::client-1': { email: 'dev@example.com' } });

    // Act & Assert
    expect(readGrokIdentities(path)).toEqual([]);
  });

  test('treats a missing or unreadable store as no accounts', () => {
    // Act & Assert
    expect(readGrokIdentities(join(makeTempDir(), 'absent.json'))).toEqual([]);
    expect(readGrokIdentities(writeAuth('not an object'))).toEqual([]);
  });
});

describe('discoverAccounts', () => {
  test('surfaces the Grok login as a read-only profile', () => {
    // Arrange — every other source points at an empty directory
    const empty = makeTempDir();
    const grokAuthPath = writeAuth({ 'https://auth.x.ai::client-1': ACCOUNT });

    // Act
    const profiles = discoverAccounts({
      claudeConfigPath: join(empty, 'claude.json'),
      codexAuthPath: join(empty, 'codex.json'),
      antigravityStoreDir: join(empty, 'antigravity'),
      opencodeAuthPath: join(empty, 'opencode.json'),
      grokAuthPath,
    });

    // Assert
    expect(profiles).toEqual([
      {
        agent: 'grok',
        accountId: ACCOUNT.user_id,
        displayLabel: 'dev@example.com',
        email: 'dev@example.com',
        organizationId: ACCOUNT.team_id,
        discoveredVia: 'grok-auth',
      },
    ]);
  });
});
