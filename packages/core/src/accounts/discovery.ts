/**
 * Read-only account discovery across local agent stores. Discovered
 * profiles feed the account_profiles registry and quota labeling only —
 * per confirmed policy they are NEVER used to backfill existing ledger
 * rows (misattribution risk), and account ids are opaque stable ids
 * (uuid-first; email is a display concern).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';
import { defaultAntigravityStoreDir, listAntigravityAccounts } from '../quota/antigravity.ts';
import { defaultClaudeConfigPath, readClaudeActiveIdentity } from './claude.ts';

export type DiscoverySource = 'claude-config' | 'codex-auth' | 'antigravity-store';

export interface AccountProfile {
  readonly agent: string;
  /** Opaque stable id: accountUuid (claude), account_id (codex), email (antigravity). */
  readonly accountId: string;
  readonly displayLabel: string;
  readonly email: string | null;
  readonly organizationId: string | null;
  readonly discoveredVia: DiscoverySource;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function discoverClaudeActive(configPath: string): AccountProfile[] {
  const identity = readClaudeActiveIdentity(configPath);
  if (identity === null) {
    return [];
  }
  const accountId = identity.accountUuid ?? identity.email;
  if (accountId === null) {
    return [];
  }
  return [
    {
      agent: 'claude-code',
      accountId,
      displayLabel: identity.email ?? accountId,
      email: identity.email,
      organizationId: identity.organizationUuid,
      discoveredVia: 'claude-config',
    },
  ];
}

/** Base64url JWT payload decode — no verification, read-only email extraction. */
export function jwtEmail(idToken: string | null): string | null {
  if (idToken === null) {
    return null;
  }
  const payload = idToken.split('.')[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    return asString(asObject(JSON.parse(decoded))?.email ?? null);
  } catch {
    return null;
  }
}

function discoverCodex(authPath: string): AccountProfile[] {
  const auth = readJson(authPath);
  const tokens = auth === null ? null : asObject(auth.tokens);
  if (tokens === null) {
    return [];
  }
  const accountId = asString(tokens.account_id);
  if (accountId === null) {
    return [];
  }
  const email = jwtEmail(asString(tokens.id_token));
  return [
    {
      agent: 'codex',
      accountId,
      displayLabel: email ?? accountId,
      email,
      organizationId: null,
      discoveredVia: 'codex-auth',
    },
  ];
}

function discoverAntigravity(storeDir: string): AccountProfile[] {
  return listAntigravityAccounts(storeDir).map((account) => ({
    agent: 'antigravity',
    accountId: account.email,
    displayLabel: account.email,
    email: account.email,
    organizationId: null,
    discoveredVia: 'antigravity-store',
  }));
}

export interface DiscoveryOptions {
  readonly claudeConfigPath?: string;
  readonly codexAuthPath?: string;
  readonly antigravityStoreDir?: string;
}

/** Later sources never overwrite an earlier profile for the same (agent, id). */
export function discoverAccounts(options: DiscoveryOptions = {}): AccountProfile[] {
  const home = homedir();
  const profiles = [
    ...discoverClaudeActive(options.claudeConfigPath ?? defaultClaudeConfigPath(home)),
    ...discoverCodex(options.codexAuthPath ?? join(home, '.codex', 'auth.json')),
    ...discoverAntigravity(options.antigravityStoreDir ?? defaultAntigravityStoreDir(home)),
  ];
  const seen = new Map<string, AccountProfile>();
  for (const profile of profiles) {
    const key = `${profile.agent} ${profile.accountId}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, profile);
    } else if (existing.email === null && profile.email !== null) {
      seen.set(key, { ...profile, discoveredVia: existing.discoveredVia });
    }
  }
  return [...seen.values()];
}
