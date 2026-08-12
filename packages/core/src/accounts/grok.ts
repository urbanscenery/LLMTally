/**
 * Read-only identity from Grok Build's credential store. The file also
 * holds the access and refresh tokens; nothing here reads, returns, or
 * logs them — llmtally never writes to ~/.grok and cannot switch Grok
 * accounts, so identity is all it needs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';

export const GROK_AGENT = 'grok';

export interface GrokIdentity {
  /** xAI user uuid — stable across logins, unlike the email. */
  readonly accountId: string;
  readonly email: string | null;
  readonly teamId: string | null;
}

export function defaultGrokAuthPath(home: string): string {
  return join(home, '.grok', 'auth.json');
}

/**
 * auth.json maps `<oidc_issuer>::<client_id>` to one credential record,
 * so a machine signed into two accounts has two entries. Records without
 * a user id are skipped rather than keyed on the email, which is a
 * display concern and may be shared by two accounts.
 */
export function readGrokIdentities(authPath: string): readonly GrokIdentity[] {
  let document: Record<string, unknown> | null;
  try {
    document = asObject(JSON.parse(readFileSync(authPath, 'utf8')));
  } catch {
    return [];
  }
  if (document === null) {
    return [];
  }
  const identities: GrokIdentity[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(document)) {
    const record = asObject(value);
    const accountId = record === null ? null : asString(record.user_id);
    if (accountId === null || seen.has(accountId)) {
      continue;
    }
    seen.add(accountId);
    identities.push({
      accountId,
      email: asString(record?.email ?? null),
      teamId: asString(record?.team_id ?? null),
    });
  }
  return identities;
}
