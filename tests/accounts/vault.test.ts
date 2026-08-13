import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compactJson,
  credentialFingerprint,
  createActiveCredentialStore,
  isWipedCredential,
  prepareForActivation,
} from '@llmtally/core/accounts/credentials.ts';
import { KeychainError, createMemoryKeychain, parseAccountAttribute } from '@llmtally/core/accounts/keychain.ts';
import type { KeychainPort } from '@llmtally/core/accounts/keychain.ts';
import { AccountVault, VaultError, normalizeAlias } from '@llmtally/core/accounts/vault.ts';
import { makeTempDir } from '../helpers.ts';

/** A keychain that exists but cannot answer (locked login keychain, timeout). */
function erroringKeychain(): KeychainPort {
  return {
    available: true,
    read: () => ({ kind: 'error', message: 'security timed out or was killed (keychain locked?)' }),
    write: () => {
      throw new KeychainError('security timed out');
    },
    remove: () => undefined,
    findAccount: () => null,
  };
}

const NOW = 1_786_400_000;

function credentials(refresh: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `access-${refresh}`,
      refreshToken: refresh,
      expiresAt: 1_800_000_000_000,
      subscriptionType: 'max',
    },
    ...extra,
  });
}

function entry(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: 'claude-code',
    accountId,
    email: `${accountId}@test.dev`,
    organizationUuid: 'org-1',
    organizationName: 'Test Org',
    alias: null,
    addedAtUtc: NOW,
    ...overrides,
  };
}

describe('parseAccountAttribute', () => {
  test('extracts the acct blob from a security attribute dump', () => {
    // Arrange
    const dump = [
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="someone"',
      '    "svce"<blob>="Claude Code-credentials"',
    ].join('\n');

    // Act & Assert
    expect(parseAccountAttribute(dump)).toBe('someone');
    expect(parseAccountAttribute('attributes:\n    "svce"<blob>="x"')).toBeNull();
  });
});

describe('credential helpers', () => {
  test('the fingerprint follows the refresh token through access rotation', () => {
    // Arrange — same account, rotated access token
    const first = credentials('refresh-1');
    const rotated = JSON.stringify({
      claudeAiOauth: { accessToken: 'access-new', refreshToken: 'refresh-1' },
    });

    // Act & Assert
    expect(credentialFingerprint(first)).toBe(credentialFingerprint(rotated));
    expect(credentialFingerprint(first)).not.toBe(credentialFingerprint(credentials('refresh-2')));
  });

  test('blank tokens are recognized as a signed-out state', () => {
    // Act & Assert
    expect(
      isWipedCredential(JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } })),
    ).toBe(true);
    expect(isWipedCredential(credentials('refresh-1'))).toBe(false);
  });

  test('machine-scoped keys come from the live copy, absence included', () => {
    // Arrange — the stored snapshot carries a stale MCP grant
    const stored = credentials('refresh-1', {
      mcpOAuth: { server: 'stale' },
      trustedDeviceToken: 'device-1',
    });
    const live = credentials('refresh-2', { mcpOAuth: { server: 'current' } });

    // Act
    const activated = JSON.parse(prepareForActivation(stored, live));
    const withoutLiveMcp = JSON.parse(prepareForActivation(stored, credentials('refresh-2')));

    // Assert — account keys move, machine keys track the live store
    expect(activated.claudeAiOauth.refreshToken).toBe('refresh-1');
    expect(activated.trustedDeviceToken).toBe('device-1');
    expect(activated.mcpOAuth).toEqual({ server: 'current' });
    expect('mcpOAuth' in withoutLiveMcp).toBe(false);
  });

  test('non-JSON credentials are rejected instead of stored', () => {
    // Act & Assert
    expect(() => compactJson('not json')).toThrow('not valid JSON');
    expect(() => compactJson('[1,2]')).toThrow('must be a JSON object');
  });
});

describe('createActiveCredentialStore', () => {
  test('keychain writes compact JSON and bump an existing credentials file', () => {
    // Arrange
    const configHome = makeTempDir();
    const filePath = join(configHome, '.credentials.json');
    writeFileSync(filePath, '{}');
    const before = statSync(filePath).mtimeMs;
    const keychain = createMemoryKeychain();
    const store = createActiveCredentialStore({ configHome, keychain, keychainAccount: 'me' });

    // Act
    store.write(`${credentials('refresh-1')}\n`);

    // Assert — stored on one line, file untouched in content but touched in mtime
    expect(store.backend).toBe('keychain');
    expect(keychain.read('Claude Code-credentials', 'me')).toEqual({
      kind: 'found',
      value: credentials('refresh-1'),
    });
    expect(readFileSync(filePath, 'utf8')).toBe('{}');
    expect(statSync(filePath).mtimeMs).toBeGreaterThanOrEqual(before);
  });

  test('a keychain-only machine never gains a plaintext credentials file', () => {
    // Arrange — no file exists to begin with
    const configHome = makeTempDir();
    const store = createActiveCredentialStore({
      configHome,
      keychain: createMemoryKeychain(),
      keychainAccount: 'me',
    });

    // Act
    store.write(credentials('refresh-1'));
    store.touch();

    // Assert
    expect(() => readFileSync(join(configHome, '.credentials.json'), 'utf8')).toThrow();
  });

  test('an unanswerable keychain makes read throw instead of reporting absence', () => {
    // Arrange — no file exists, and the keychain cannot answer
    const configHome = makeTempDir();
    const store = createActiveCredentialStore({
      configHome,
      keychain: erroringKeychain(),
      keychainAccount: 'me',
    });

    // Act & Assert — "unknown" must never read as "signed out"
    expect(() => store.read()).toThrow(/refusing to treat them as absent/);
  });

  test('without a keychain the file backend is used at 0600', () => {
    // Arrange
    const configHome = makeTempDir();
    const store = createActiveCredentialStore({
      configHome,
      keychain: createMemoryKeychain(false),
    });

    // Act
    store.write(credentials('refresh-1'));

    // Assert
    const filePath = join(configHome, '.credentials.json');
    expect(store.backend).toBe('file');
    expect(store.read()).toBe(credentials('refresh-1'));
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

describe('AccountVault', () => {
  function makeVault(available = true) {
    return new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain(available) });
  }

  test('stores credentials in the keychain and reads them back', () => {
    // Arrange
    const vault = makeVault();

    // Act
    const stored = vault.put(entry('uuid-1'), credentials('refresh-1'));

    // Assert
    expect(stored.backend).toBe('keychain');
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-1'));
    expect(vault.list()).toHaveLength(1);
  });

  test('falls back to a 0600 file when no keychain is available', () => {
    // Arrange
    const vault = makeVault(false);

    // Act
    const stored = vault.put(entry('uuid-1'), credentials('refresh-1'));

    // Assert
    expect(stored.backend).toBe('file');
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-1'));
    expect(statSync(join(vault.directory, 'claude-code--uuid-1.cred')).mode & 0o777).toBe(0o600);
  });

  test('empty credentials are refused rather than stored', () => {
    // Act & Assert
    expect(() => makeVault().put(entry('uuid-1'), '')).toThrow('refusing to store empty');
  });

  test('resolve accepts id, alias, and email but refuses an ambiguous email', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1', { alias: 'work' }), credentials('refresh-1'));
    vault.put(entry('uuid-2', { email: 'uuid-1@test.dev' }), credentials('refresh-2'));

    // Act & Assert
    expect(vault.resolve('claude-code', 'uuid-2').accountId).toBe('uuid-2');
    expect(vault.resolve('claude-code', 'work').accountId).toBe('uuid-1');
    expect(() => vault.resolve('claude-code', 'uuid-1@test.dev')).toThrow('matches 2 accounts');
    expect(() => vault.resolve('claude-code', 'nobody')).toThrow('no stored account');
  });

  test('aliases are normalized and cannot collide', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    vault.put(entry('uuid-2'), credentials('refresh-2'));

    // Act
    vault.setAlias('claude-code', 'uuid-1', 'Work');

    // Assert
    expect(vault.get('claude-code', 'uuid-1')?.alias).toBe('work');
    expect(() => vault.setAlias('claude-code', 'uuid-2', 'work')).toThrow('already used');
    expect(() => normalizeAlias('12')).toThrow('invalid alias');
    expect(() => normalizeAlias('-x')).toThrow('invalid alias');
  });

  test('removing an account clears its credentials and active marker', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    vault.setActive('claude-code', 'uuid-1');

    // Act
    vault.remove('claude-code', 'uuid-1');

    // Assert
    expect(vault.list()).toHaveLength(0);
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBeNull();
    expect(vault.activeAccountId('claude-code')).toBeNull();
  });

  test('a crafted account id cannot escape the vault or inject a command', () => {
    // Arrange — both PoCs from the security review, built at runtime
    const vault = makeVault(false);
    const injected = `victim${String.fromCharCode(10)}delete-generic-password -s llmtally`;
    const traversal = '../../../../tmp/escaped';

    // Act & Assert — refused before any file or keychain call
    for (const accountId of [injected, traversal, 'has/slash', '', 'a'.repeat(129)]) {
      expect(() => vault.put(entry(accountId), credentials('refresh-1'))).toThrow(
        'refusing to use account id',
      );
    }
    expect(vault.list()).toHaveLength(0);
  });

  test('a keychain write failure removes the stale row it would otherwise hide behind', () => {
    // Arrange — first store succeeds, then the payload outgrows the CLI
    const vault = new AccountVault({
      dir: makeTempDir(),
      keychain: createMemoryKeychain(true, 4000),
    });
    vault.put(entry('uuid-1'), credentials('refresh-old'));
    const huge = JSON.stringify({
      claudeAiOauth: { accessToken: 'x'.repeat(6000), refreshToken: 'refresh-new' },
    });

    // Act
    const stored = vault.put(entry('uuid-1'), huge);

    // Assert — the newer credentials are what comes back, not the old row
    expect(stored.backend).toBe('file');
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(huge);
  });

  test('an unanswerable keychain makes loadCredentials throw, not report absence', () => {
    // Arrange — stored while the keychain worked; read while it cannot
    // prove it holds nothing newer
    const dir = makeTempDir();
    const healthy = new AccountVault({ dir, keychain: createMemoryKeychain() });
    healthy.put(entry('uuid-1'), credentials('refresh-1'));
    const vault = new AccountVault({ dir, keychain: erroringKeychain() });

    // Act & Assert — absence is a verdict; a locked keychain has none
    expect(() => vault.loadCredentials('claude-code', 'uuid-1')).toThrow(/unreadable right now/);
  });

  test('a write that can neither store nor clear the keychain row aborts the put', () => {
    // Arrange — the keychain refuses the write AND cannot prove the old
    // row is gone; a file fallback would be shadowed by stale bytes the
    // moment the keychain answers again
    const vault = new AccountVault({ dir: makeTempDir(), keychain: erroringKeychain() });

    // Act & Assert — nothing stored, registry untouched
    expect(() => vault.put(entry('uuid-1'), credentials('refresh-1'))).toThrow(
      /could not be cleared/,
    );
    expect(vault.list()).toHaveLength(0);
    expect(() => readFileSync(join(vault.directory, 'claude-code--uuid-1.cred'))).toThrow();
  });

  test('unclaimed credentials are preserved with a manifest', () => {
    // Arrange
    const vault = makeVault();

    // Act
    const id = vault.stashUnclaimed(credentials('refresh-x'), 'no match', NOW);

    // Assert
    const stashed = readFileSync(join(vault.directory, 'unclaimed', `${id}.cred`), 'utf8');
    expect(Buffer.from(stashed, 'base64').toString('utf8')).toBe(credentials('refresh-x'));
    expect(readFileSync(join(vault.directory, 'unclaimed', `${id}.json`), 'utf8')).toContain(
      'no match',
    );
  });
});

describe('refresh quarantine and credential CAS', () => {
  function makeVault(): AccountVault {
    return new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain() });
  }

  test('a registry written before the field reads as not quarantined', () => {
    // Arrange — simulate an old registry: put, then strip the field on disk
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    const registryPath = join(vault.directory, 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    delete registry.accounts['claude-code:uuid-1'].refreshDeadAtUtc;
    writeFileSync(registryPath, JSON.stringify(registry));

    // Act & Assert
    expect(vault.get('claude-code', 'uuid-1')?.refreshDeadAtUtc).toBeNull();
  });

  test('quarantine only lands on the generation that was judged', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-old'));
    const oldFingerprint = credentialFingerprint(credentials('refresh-old'));

    // Act — the lineage rotates before the verdict arrives
    vault.put(entry('uuid-1'), credentials('refresh-new'));
    const late = vault.markRefreshDeadIfFingerprint('claude-code', 'uuid-1', oldFingerprint, NOW);
    // ...and on the current generation it sticks
    const current = vault.markRefreshDeadIfFingerprint(
      'claude-code',
      'uuid-1',
      credentialFingerprint(credentials('refresh-new')),
      NOW + 1,
    );

    // Assert
    expect(late).toBe('changed');
    expect(current).toBe('updated');
    expect(vault.get('claude-code', 'uuid-1')?.refreshDeadAtUtc).toBe(NOW + 1);
  });

  test('replaceCredentialsIfFingerprint swaps the generation and lifts quarantine', () => {
    // Arrange — a quarantined account whose refresh finally succeeded
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-old'));
    vault.markRefreshDeadIfFingerprint('claude-code', 'uuid-1', credentialFingerprint(credentials('refresh-old')), NOW);

    // Act
    const result = vault.replaceCredentialsIfFingerprint(
      'claude-code',
      'uuid-1',
      credentialFingerprint(credentials('refresh-old')),
      credentials('refresh-rotated'),
      { clearRefreshDead: true },
    );

    // Assert
    expect(result).toBe('updated');
    expect(vault.get('claude-code', 'uuid-1')?.refreshDeadAtUtc).toBeNull();
    expect(JSON.parse(vault.loadCredentials('claude-code', 'uuid-1') ?? '{}').claudeAiOauth.refreshToken).toBe(
      'refresh-rotated',
    );
  });

  test('a metadata put without the field preserves an existing quarantine', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    vault.markRefreshDeadIfFingerprint('claude-code', 'uuid-1', credentialFingerprint(credentials('refresh-1')), NOW);

    // Act — e.g. an alias update re-puts the entry without deciding
    vault.put(entry('uuid-1', { alias: 'work' }), credentials('refresh-1'));

    // Assert
    expect(vault.get('claude-code', 'uuid-1')?.refreshDeadAtUtc).toBe(NOW);
  });

  test('a held mutation lock makes polling-path mutations defer as busy', () => {
    // Arrange — another "process" holds the lock via its own connection
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    const fingerprint = credentialFingerprint(credentials('refresh-1'));
    const holder = new Database(join(vault.directory, '.mutation-lock.db'), {
      create: true,
      strict: true,
    });
    holder.exec('PRAGMA busy_timeout = 0;');
    holder.exec('BEGIN IMMEDIATE;');

    // Act — the polling-path mutation must skip, not stall
    const busy = vault.markRefreshDeadIfFingerprint('claude-code', 'uuid-1', fingerprint, NOW);
    holder.exec('ROLLBACK;');
    holder.close();
    const released = vault.markRefreshDeadIfFingerprint('claude-code', 'uuid-1', fingerprint, NOW);

    // Assert — a crashed/closed holder releases the lock automatically
    expect(busy).toBe('busy');
    expect(released).toBe('updated');
  });

});

describe('registry mutations under the lock', () => {
  test('registry writes defer to a held lock instead of racing it', () => {
    // Arrange
    const vault = new AccountVault({
      dir: makeTempDir(),
      keychain: createMemoryKeychain(),
      writeLockWaitMs: 50,
    });
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    const holder = new Database(join(vault.directory, '.mutation-lock.db'), {
      create: true,
      strict: true,
    });
    holder.exec('PRAGMA busy_timeout = 0;');
    holder.exec('BEGIN IMMEDIATE;');

    // Act & Assert — the alias write refuses to bypass the lock
    // (bounded wait, then a loud failure instead of a silent race)
    expect(() => vault.setAlias('claude-code', 'uuid-1', 'work')).toThrow(/vault lock/);
    holder.exec('ROLLBACK;');
    holder.close();
    expect(vault.setAlias('claude-code', 'uuid-1', 'work').alias).toBe('work');
  });
});

describe('multi-agent registry (v2)', () => {
  function makeVault(available = true) {
    return new AccountVault({ dir: makeTempDir(), keychain: createMemoryKeychain(available) });
  }

  function codexEntry(accountId: string, overrides: Record<string, unknown> = {}) {
    return entry(accountId, { agent: 'codex', email: null, ...overrides });
  }

  test('two agents may store the same account id without colliding', () => {
    // Arrange — the D-08 collision: both agents issued the same id
    const vault = makeVault();

    // Act
    vault.put(entry('uuid-1'), credentials('refresh-claude'));
    vault.put(codexEntry('uuid-1'), '{"tokens":{"refresh_token":"rt-codex"}}');

    // Assert — both entries survive with their own credentials
    expect(vault.list()).toHaveLength(2);
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-claude'));
    expect(vault.loadCredentials('codex', 'uuid-1')).toBe('{"tokens":{"refresh_token":"rt-codex"}}');
    expect(vault.get('claude-code', 'uuid-1')?.agent).toBe('claude-code');
    expect(vault.get('codex', 'uuid-1')?.agent).toBe('codex');
  });

  test("removing one agent's account leaves the other agent's intact", () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-claude'));
    vault.put(codexEntry('uuid-1'), '{"tokens":{"refresh_token":"rt-codex"}}');

    // Act
    vault.remove('codex', 'uuid-1');

    // Assert
    expect(vault.get('codex', 'uuid-1')).toBeNull();
    expect(vault.loadCredentials('codex', 'uuid-1')).toBeNull();
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-claude'));
  });

  test('active markers are tracked per agent', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    vault.put(codexEntry('acct-9'), '{"tokens":{"refresh_token":"rt"}}');

    // Act
    vault.setActive('claude-code', 'uuid-1');
    vault.setActive('codex', 'acct-9');

    // Assert — one agent's switch never moves another agent's marker
    expect(vault.activeAccountId('claude-code')).toBe('uuid-1');
    expect(vault.activeAccountId('codex')).toBe('acct-9');
    vault.setActive('codex', null);
    expect(vault.activeAccountId('claude-code')).toBe('uuid-1');
    expect(vault.activeAccountId('codex')).toBeNull();
  });

  test('the same alias may exist on two agents but not twice within one', () => {
    // Arrange
    const vault = makeVault();
    vault.put(entry('uuid-1'), credentials('refresh-1'));
    vault.put(entry('uuid-2'), credentials('refresh-2'));
    vault.put(codexEntry('acct-9'), '{"tokens":{"refresh_token":"rt"}}');

    // Act & Assert — resolve() is agent-scoped, so cross-agent reuse is safe
    vault.setAlias('claude-code', 'uuid-1', 'work');
    expect(vault.setAlias('codex', 'acct-9', 'work').alias).toBe('work');
    expect(() => vault.setAlias('claude-code', 'uuid-2', 'work')).toThrow('already used');
  });

  test('a v1 registry is read transparently and converges to v2 on the first mutation', () => {
    // Arrange — a vault written by the accountId-keyed format
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({
        version: 1,
        activeAccountId: 'uuid-1',
        accounts: {
          'uuid-1': {
            agent: 'claude-code',
            email: 'uuid-1@test.dev',
            organizationUuid: null,
            organizationName: null,
            alias: null,
            addedAtUtc: NOW,
            backend: 'file',
          },
          'acct-9': {
            agent: 'codex',
            email: null,
            organizationUuid: null,
            organizationName: null,
            alias: null,
            addedAtUtc: NOW,
            backend: 'file',
          },
        },
      }),
    );
    const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    writeFileSync(join(dir, 'uuid-1.cred'), encode(credentials('refresh-1')));
    writeFileSync(join(dir, 'acct-9.cred'), encode('{"tokens":{"refresh_token":"rt"}}'));
    const vault = new AccountVault({ dir, keychain: createMemoryKeychain(false) });

    // Act & Assert — reads work off the v1 file and the legacy names
    expect(vault.list()).toHaveLength(2);
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-1'));
    expect(vault.loadCredentials('codex', 'acct-9')).toBe('{"tokens":{"refresh_token":"rt"}}');
    // the v1 marker belongs to the agent of the entry it names
    expect(vault.activeAccountId('claude-code')).toBe('uuid-1');
    expect(vault.activeAccountId('codex')).toBeNull();

    // Act — the first mutation persists the converted form
    vault.put(entry('uuid-1', { email: 'uuid-1@test.dev' }), credentials('refresh-2'));

    // Assert — v2 on disk, credentials under the agent-qualified name
    const registry = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'));
    expect(registry.version).toBe(2);
    expect(registry.accounts['claude-code:uuid-1'].accountId).toBe('uuid-1');
    expect(registry.accounts['codex:acct-9'].agent).toBe('codex');
    expect(registry.active['claude-code']).toBe('uuid-1');
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-2'));
    expect(readFileSync(join(dir, 'claude-code--uuid-1.cred'), 'utf8')).toBe(
      encode(credentials('refresh-2')),
    );
    // the legacy file is gone once nothing else can depend on it
    expect(() => readFileSync(join(dir, 'uuid-1.cred'))).toThrow();
  });

  test('removing an account aborts when the keychain cannot delete its secret', () => {
    // Arrange — the item reads fine but the delete fails (locked mid-way)
    const backing = createMemoryKeychain();
    const stubborn = {
      available: true,
      read: backing.read,
      write: backing.write,
      remove: (): void => {
        throw new KeychainError('security timed out while deleting the item');
      },
      findAccount: backing.findAccount,
    };
    const vault = new AccountVault({ dir: makeTempDir(), keychain: stubborn });
    vault.put(entry('uuid-1'), credentials('refresh-1'));

    // Act & Assert — reporting "removed" while the secret survives in
    // the keychain would be a lie; the registry must stay consistent
    expect(() => vault.remove('claude-code', 'uuid-1')).toThrow(/timed out/);
    expect(vault.get('claude-code', 'uuid-1')).not.toBeNull();
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-1'));
  });

  test('a v1 collision leaves the shared legacy file for the other agent', () => {
    // Arrange — v1 could only keep one entry per id; the codex one won,
    // but the legacy .cred file is the only copy either agent has
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({
        version: 1,
        activeAccountId: null,
        accounts: {
          'uuid-1': {
            agent: 'codex',
            email: null,
            organizationUuid: null,
            organizationName: null,
            alias: null,
            addedAtUtc: NOW,
            backend: 'file',
          },
        },
      }),
    );
    const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    writeFileSync(join(dir, 'uuid-1.cred'), encode('{"tokens":{"refresh_token":"rt-codex"}}'));
    const vault = new AccountVault({ dir, keychain: createMemoryKeychain(false) });

    // Act — claude re-captures the same id as its own account
    vault.put(entry('uuid-1'), credentials('refresh-claude'));

    // Assert — the codex entry can still read its only copy, which the
    // mutation materialized under its own qualified name; the ambiguous
    // legacy name is gone
    expect(vault.loadCredentials('codex', 'uuid-1')).toBe('{"tokens":{"refresh_token":"rt-codex"}}');
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-claude'));
    expect(() => readFileSync(join(dir, 'uuid-1.cred'))).toThrow();
    expect(readFileSync(join(dir, 'codex--uuid-1.cred'), 'utf8')).toBe(
      encode('{"tokens":{"refresh_token":"rt-codex"}}'),
    );

    // Act — removing one agent must not leave its secret readable by the other
    vault.remove('codex', 'uuid-1');

    // Assert
    expect(vault.loadCredentials('codex', 'uuid-1')).toBeNull();
    expect(() => readFileSync(join(dir, 'codex--uuid-1.cred'))).toThrow();
    expect(vault.loadCredentials('claude-code', 'uuid-1')).toBe(credentials('refresh-claude'));
  });
});

describe('registry corruption', () => {
  test('a corrupt registry fails closed instead of posing as empty', () => {
    // Arrange — a vault with one account, then the registry rots
    const dir = makeTempDir();
    const vault = new AccountVault({ dir, keychain: createMemoryKeychain() });
    vault.put(
      {
        agent: 'claude-code',
        accountId: 'acct-1',
        email: 'a@test.dev',
        organizationUuid: null,
        organizationName: null,
        alias: 'main',
        addedAtUtc: 1,
        refreshDeadAtUtc: null,
      },
      '{"tok":1}',
    );
    writeFileSync(join(dir, 'registry.json'), '{ this is not json');

    // Act & Assert — reads throw a VaultError; nothing pretends the
    // vault is empty, so no later put can atomically erase the metadata
    expect(() => vault.list()).toThrow(VaultError);
    expect(() =>
      vault.put(
        {
          agent: 'codex',
          accountId: 'acct-2',
          email: null,
          organizationUuid: null,
          organizationName: null,
          alias: null,
          addedAtUtc: 2,
          refreshDeadAtUtc: null,
        },
        '{"tok":2}',
      ),
    ).toThrow(VaultError);
  });

  test('a missing registry is still an empty vault', () => {
    const vault = new AccountVault({ dir: join(makeTempDir(), 'fresh'), keychain: createMemoryKeychain() });
    expect(vault.list()).toEqual([]);
  });
});
