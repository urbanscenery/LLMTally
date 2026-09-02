/**
 * Live Cursor CLI quota for vault-stored accounts that are not in the
 * live Keychain/`cli-config.json` slot. Tokens are spent as stored —
 * never refreshed. Rotation is unconfirmed, and minting from a stored
 * copy could invalidate a generation the CLI still holds.
 */
import {
  CURSOR_CLI_AGENT,
  credentialsFromVaultDocument,
  cursorCliBackendOrigin,
  readStoredCursorCliDocument,
} from '../accounts/cursor-cli.ts';
import { VaultError } from '../accounts/vault.ts';
import type { AccountVault, VaultEntry } from '../accounts/vault.ts';
import { fetchCursorCliQuota } from './cursor-cli.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot } from './providers.ts';

export interface VaultCursorCliQuotaOptions {
  readonly vault: AccountVault;
  readonly activeAccountIds: readonly string[];
  readonly nowUtc: number;
  readonly home?: string;
  readonly fetchFn?: FetchLike;
  readonly only?: string;
}

function label(entry: VaultEntry): string {
  return (entry.email ?? entry.accountId) + (entry.alias === null ? '' : ` [${entry.alias}]`);
}

function unavailable(entry: VaultEntry, nowUtc: number, reason: string): QuotaSnapshot {
  return makeQuotaSnapshot({
    agent: CURSOR_CLI_AGENT,
    accountId: entry.accountId,
    account: label(entry),
    source: 'vendor_api',
    observedAtUtc: nowUtc,
    windows: [],
    failure: { kind: 'unavailable', failedAtUtc: nowUtc, retryAtUtc: null },
    warnings: [reason],
  });
}

export async function readVaultCursorCliQuota(
  options: VaultCursorCliQuotaOptions,
): Promise<readonly QuotaSnapshot[]> {
  const active = new Set(options.activeAccountIds);
  const targets = options.vault
    .list()
    .filter((entry) => entry.agent === CURSOR_CLI_AGENT && !active.has(entry.accountId))
    .filter((entry) => options.only === undefined || entry.accountId === options.only);
  const fetchFn = options.fetchFn ?? fetch;

  return Promise.all(
    targets.map(async (entry) => {
      try {
        const storedText = options.vault.loadCredentials(entry.agent, entry.accountId);
        const stored = storedText === null ? null : readStoredCursorCliDocument(storedText);
        if (storedText === null || stored === null) {
          return unavailable(entry, options.nowUtc, 'no stored credentials to read quota with');
        }
        return fetchCursorCliQuota({
          credentials: credentialsFromVaultDocument(stored),
          identity: {
            accountId: stored.userId,
            email: stored.email,
            displayName: stored.displayName,
            authId: stored.authId,
          },
          nowUtc: options.nowUtc,
          origin: cursorCliBackendOrigin(options.home),
          fetchFn,
        });
      } catch (error) {
        if (error instanceof VaultError) {
          return unavailable(entry, options.nowUtc, `${error.message}; will retry`);
        }
        throw error;
      }
    }),
  );
}
