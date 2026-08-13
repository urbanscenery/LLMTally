/**
 * Composes all quota sources into one snapshot list for the TUI: the
 * account that is logged in right now plus every other account stored
 * in the vault, each read with its own token.
 *
 * Which account is "active" is resolved once per load from the live
 * login (`~/.claude.json`) and passed to every consumer — the vault
 * registry marker is only a fallback when that file is unreadable, and
 * is silently re-synced otherwise. The same load re-captures fresh
 * credentials for a quarantined account when the user logged back into
 * it elsewhere.
 *
 * With a database path, successful readings are persisted as history
 * samples (best-effort), empty snapshots are backfilled from the
 * stored last-good reading (marked `stored_history`, never fabricated),
 * and the cross-process fetch-state store becomes the budget authority.
 */
import { readFileSync } from 'node:fs';

import { resolveActiveClaudeContext } from '../accounts/active-claude.ts';
import { syncActiveCodexCredential } from '../accounts/codex-live-sync.ts';
import { syncActiveClaudeCredential, verifyLiveCredentialOwner } from '../accounts/live-sync.ts';
import type { ActiveClaudeContext } from '../accounts/active-claude.ts';
import { createActiveCredentialStore, oauthAccessToken, oauthRefreshToken } from '../accounts/credentials.ts';
import type { ActiveCredentialStore } from '../accounts/credentials.ts';
import type { ProfileFetch } from '../accounts/oauth-profile.ts';
import {
  OPENCODE_AGENT,
  defaultOpencodeAuthPath,
  formatOpencodeAccountLabel,
  opencodeAccountId,
  readOpencodeApiKey,
  readOpencodeDisplayEmail,
  readOpencodeProviders,
  syncOpencodeLiveIdentity,
} from '../accounts/opencode.ts';
import { AccountVault } from '../accounts/vault.ts';
import type { VaultEntry } from '../accounts/vault.ts';
import { CLINE_PASS_PROVIDER, clinePassQuotaSubject, fetchClinePassQuota } from './cline.ts';
import {
  OPENCODE_GO_PROVIDER,
  fetchOpencodeGoQuota,
  opencodeGoQuotaSubject,
} from './opencode.ts';
import { readVaultAccountsQuota } from './vault-accounts.ts';
import { openDatabase } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';
import {
  defaultAntigravityStoreDir,
  listAntigravityAccounts,
  readAntigravityQuota,
} from './antigravity.ts';
import {
  codexQuotaSubject,
  defaultCodexAuthPath,
  fetchCodexUsage,
  readCodexAuth,
} from './codex-live.ts';
import type { CodexAuth } from './codex-live.ts';
import { readVaultCodexQuota } from './codex-vault.ts';
import {
  fetchClaudeQuota,
  makeQuotaSnapshot,
  readCodexQuota,
} from './providers.ts';
import type { QuotaSnapshot } from './providers.ts';
import { openQuotaFetchStateStore } from './fetch-state.ts';
import type { QuotaFetchStateStore, QuotaThrottleSubject } from './fetch-state.ts';
import {
  defaultGrokCredentials,
  fetchGrokQuota,
  grokQuotaSubject,
  readGrokCredentials,
} from './grok.ts';
import { readStoredLastGood, recordQuotaSamples } from './store.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import { accessTokenFingerprint, claudeQuotaSubject, throttledQuota } from './throttle.ts';

export type QuotaAgentFilter =
  | 'claude-code'
  | 'codex'
  | 'antigravity'
  | 'opencode'
  | 'cline'
  | 'grok'
  | null;

/**
 * Cadence for the OpenCode/Cline subscription endpoints. Neither vendor
 * publishes a polling contract, so this is our own conservative floor,
 * not a promise either of them made: the shortest window they report is
 * five hours, which a five-minute reading tracks with room to spare.
 */
const SUBSCRIPTION_CADENCE_SECONDS = 300;

export async function loadAllQuota(options: {
  readonly agent?: QuotaAgentFilter;
  readonly nowUtc?: number;
  /** Ledger path for sample recording, stored fallback, and the shared fetch budget. */
  readonly databasePath?: string;
  /** false = never call OAuth token endpoints (pure read-only mode). */
  readonly allowRefresh?: boolean;
  /** Injected in tests; production opens the real vault. */
  readonly vault?: AccountVault;
  /** Injected in tests; production resolves from ~/.claude.json. */
  readonly activeContext?: ActiveClaudeContext;
  readonly activeStore?: ActiveCredentialStore;
  /** Injected in tests; production reads the XDG opencode auth file. */
  readonly opencodeAuthPath?: string;
  /** Injected in tests; production reads ~/.grok/auth.json. */
  readonly grokAuthPath?: string;
  /** Injected in tests; production reads ~/.codex/auth.json. */
  readonly codexAuthPath?: string;
  /** Injected in tests; production probes the OAuth profile endpoint. */
  readonly profileFetchFn?: ProfileFetch;
} = {}): Promise<QuotaSnapshot[]> {
  const agent = options.agent ?? null;
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const vault = options.vault ?? new AccountVault();
  const context = options.activeContext ?? resolveActiveClaudeContext({ vault });
  const activeStore = options.activeStore ?? createActiveCredentialStore();

  // Before any stored account is refreshed: Claude Code rotates the
  // active account's lineage during normal use, and a vault still
  // holding the consumed predecessor would spend the next refresh on a
  // grant the server already killed. Mirroring costs no token-endpoint
  // request and lifts a stale quarantine on the way through.
  if (options.allowRefresh !== false) {
    try {
      await syncActiveClaudeCredential({
        context,
        vault,
        activeStore,
        nowUtc: now,
        fetchFn: options.profileFetchFn,
      });
    } catch {
      // self-healing is opportunistic; quota display must not depend on it
    }
  }
  // The same hazard on the codex side, and free of charge: auth.json
  // names its own owner, so mirroring a rotation needs no network at
  // all. Runs even in read-only mode for that reason.
  if (agent === null || agent === 'codex') {
    try {
      syncActiveCodexCredential({
        vault,
        authPath: options.codexAuthPath ?? defaultCodexAuthPath(),
        nowUtc: now,
      });
    } catch {
      // opportunistic, exactly like the Claude mirror above
    }
  }
  // OpenCode's account id is derived from the provider list, so adding
  // a provider (xai onto an existing go+cline login) would otherwise
  // leave the previous id sitting next to the live one as a second row.
  if (agent === null || agent === 'opencode' || agent === 'cline') {
    try {
      syncOpencodeLiveIdentity({
        vault,
        authPath: options.opencodeAuthPath ?? defaultOpencodeAuthPath(),
        nowUtc: now,
      });
    } catch {
      // opportunistic: a stale predecessor is a display glitch, not a
      // lost credential — the live file still holds the current set
    }
  }

  // The persistent store is the budget authority whenever a ledger is
  // configured. If it cannot be opened, Claude vendor calls are skipped
  // entirely (fail toward under-spending) rather than free-running.
  let stateStore: QuotaFetchStateStore | null = null;
  let stateStoreUnavailable = false;
  if (options.databasePath !== undefined) {
    try {
      stateStore = openQuotaFetchStateStore(options.databasePath, now);
    } catch {
      stateStoreUnavailable = true;
    }
  }

  // read once per load and shared by both codex passes: the active
  // account decides a budget key on one side and an exclusion on the
  // other, and if those two ever named different accounts, one account
  // would be read by neither
  const codexAuth =
    agent === null || agent === 'codex'
      ? readCodexAuth(options.codexAuthPath ?? defaultCodexAuthPath())
      : null;

  // read once per load and share: the OpenCode and Cline readings must
  // agree about which credential set was live while they ran
  const bundles =
    agent === null || agent === 'opencode' || agent === 'cline'
      ? listOpencodeBundles(vault, options.opencodeAuthPath)
      : [];

  try {
    const [claude, codexLive, antigravity, opencode, cline, grok] = await Promise.all([
      agent === null || agent === 'claude-code'
        ? loadActiveClaudeQuota(context, now, stateStore, stateStoreUnavailable, activeStore, options.profileFetchFn)
        : null,
      agent === null || agent === 'codex' ? throttledCodexLive(codexAuth, now) : null,
      agent === null || agent === 'antigravity'
        ? loadAntigravityQuota(now, options.allowRefresh)
        : null,
      agent === null || agent === 'opencode'
        ? loadOpencodeGoQuota(bundles, now, stateStore, stateStoreUnavailable)
        : null,
      agent === null || agent === 'cline'
        ? loadClineQuota(bundles, now, stateStore, stateStoreUnavailable)
        : null,
      agent === null || agent === 'grok'
        ? loadGrokQuota(now, stateStore, stateStoreUnavailable, options.grokAuthPath)
        : null,
    ]);

    const snapshots: QuotaSnapshot[] = [];
    if (claude !== null) {
      snapshots.push(claude);
      try {
        const stored = await Promise.all(
          vault
            .list()
            .filter(
              (entry) =>
                entry.agent === 'claude-code' && entry.accountId !== context.activeAccountId,
            )
            .map(async (entry) =>
              throttledQuota(
                storedAccountSubject(vault, entry),
                now,
                async () => {
                  const [snapshot] = await readVaultAccountsQuota({
                    vault,
                    activeContext: context,
                    nowUtc: now,
                    only: entry.accountId,
                    allowRefresh: options.allowRefresh,
                    // a slot whose family a live session owns must not
                    // be double-rotated by this poll
                    liveRefreshToken: () => {
                      const liveBytes = activeStore.read();
                      return liveBytes === null ? null : oauthRefreshToken(liveBytes);
                    },
                  });
                  // never substitute another account's reading: an empty
                  // result stays attributed to THIS entry
                  return (
                    snapshot ??
                    makeQuotaSnapshot({
                      agent: 'claude-code',
                      accountId: entry.accountId,
                      account: entry.email ?? entry.accountId,
                      source: 'vendor_api',
                      observedAtUtc: now,
                      windows: [],
                      failure: { kind: 'unavailable', failedAtUtc: now, retryAtUtc: null },
                      warnings: ['stored account produced no reading'],
                    })
                  );
                },
                { stateStore, stateStoreUnavailable },
              ),
            ),
        );
        snapshots.push(...stored);
      } catch {
        // a vault problem must not take the live reading down with it
      }
    }
    if (agent === null || agent === 'codex') {
      snapshots.push(codexSnapshot(codexLive, now));
      try {
        snapshots.push(
          ...(await loadStoredCodexQuota(
            vault,
            codexAuth?.accountId ?? null,
            now,
            options.allowRefresh,
          )),
        );
      } catch {
        // a vault problem must not take the live reading down with it
      }
    }
    if (antigravity !== null) {
      snapshots.push(...antigravity);
    }
    if (opencode !== null) {
      snapshots.push(...opencode);
    }
    if (cline !== null) {
      snapshots.push(...cline);
    }
    if (grok !== null) {
      snapshots.push(...grok);
    }
    const withHistory =
      options.databasePath === undefined
        ? snapshots
        : withQuotaHistory(snapshots, options.databasePath, now);
    return dedupeByAccount(withHistory);
  } finally {
    stateStore?.close();
  }
}

/**
 * Stored accounts claim under the same key format as the live path —
 * the vendor budgets requests per access token, so the same token must
 * spend ONE budget whether its account is active or not (an account
 * that just went inactive would otherwise get a fresh budget for a
 * token the live path already spent). Unreadable credentials fall back
 * to an account-scoped key: budgeting still happens, just conservatively.
 *
 * Known window (accepted): when the callback renews an expired token,
 * that one usage call is recorded under the pre-rotation key and the
 * rotated token starts a fresh row on the next poll. The vendor's
 * budget genuinely resets with the rotation, so the extra call is
 * vendor-legal and bounded to one per rotation (~token lifetime); the
 * alternative — a lineage-scoped key — would reopen the live/stored
 * double-budget this key exists to close.
 */
function storedAccountSubject(
  vault: AccountVault,
  entry: VaultEntry,
): QuotaThrottleSubject {
  let token: string | null = null;
  try {
    const stored = vault.loadCredentials(entry.agent, entry.accountId);
    token = stored === null ? null : oauthAccessToken(stored);
  } catch {
    // an unanswerable keychain still gets a budget key, just not a token one
  }
  return {
    key:
      token === null
        ? `claude-code|ua=${LLMTALLY_USER_AGENT}|acct=${entry.accountId}`
        : `claude-code|ua=${LLMTALLY_USER_AGENT}|token=${accessTokenFingerprint(token)}`,
    agent: 'claude-code',
    accountId: entry.accountId,
    account: entry.email ?? entry.accountId,
  };
}

async function loadActiveClaudeQuota(
  context: ActiveClaudeContext,
  now: number,
  stateStore: QuotaFetchStateStore | null,
  stateStoreUnavailable: boolean,
  activeStore: ActiveCredentialStore,
  profileFetchFn?: ProfileFetch,
): Promise<QuotaSnapshot> {
  if (context.status === 'signed_out') {
    // a deliberate sign-out ends the live account's story: a residual
    // token in the credential store must not be spent on its behalf
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: now,
      windows: [],
      failure: { kind: 'unavailable', failedAtUtc: now, retryAtUtc: null },
      warnings: ['no Claude Code account is signed in'],
    });
  }
  // the credentials are read once per load: they name the budget key and
  // the token is then injected into the fetch so the two cannot disagree
  let live: string | null = null;
  try {
    live = activeStore.read();
  } catch {
    // an unanswerable keychain degrades to the token-less path below
  }
  const token = live === null ? null : oauthAccessToken(live);
  const accountId = context.activeAccountId;
  const account = context.identity?.email ?? null;
  // `/login` writes the credential store and ~/.claude.json separately,
  // so the bytes can briefly belong to another account than the config
  // names. The oracle's verdict is memoized per lineage; on a mismatch
  // the reading is deferred rather than recorded under the wrong account.
  if (live !== null && token !== null && context.status === 'identified') {
    const owner = await verifyLiveCredentialOwner({
      accountId: context.activeAccountId,
      credentials: live,
      nowUtc: now,
      fetchFn: profileFetchFn,
    });
    if (owner.status === 'foreign') {
      // split-brain: refuse the live read (it would record the OTHER
      // account's usage under this row) but say precisely why, and
      // carry the confirmed owner so the UI can show both identities
      return makeQuotaSnapshot({
        agent: 'claude-code',
        accountId,
        account,
        source: 'vendor_api',
        observedAtUtc: now,
        windows: [],
        failure: {
          kind: 'account_mismatch',
          failedAtUtc: now,
          retryAtUtc: null,
          credentialOwner: {
            accountId: owner.ownerAccountUuid,
            account: owner.ownerEmail,
          },
        },
        warnings: [
          'the live credentials belong to a different account than ~/.claude.json names — quit or re-login the running Claude Code session, then switch again',
        ],
      });
    }
  }
  const subject =
    token === null
      ? {
          key: `claude-code|ua=${LLMTALLY_USER_AGENT}|token=none`,
          agent: 'claude-code',
          accountId,
          account,
        }
      : claudeQuotaSubject({ accessToken: token, accountId, account });
  return throttledQuota(
    subject,
    now,
    () =>
      fetchClaudeQuota({
        nowUtc: now,
        tokenReader: () => token,
        identityReader: () => context.identity,
      }),
    // without a token no vendor call can happen anyway, so a signed-out
    // poll must not spend shared claim transactions
    token === null
      ? {}
      : { stateStore, stateStoreUnavailable },
  );
}

/**
 * One OpenCode credential set: the switchable unit, and the only place
 * a provider key for it can be read from.
 */
interface OpencodeBundle {
  readonly accountId: string;
  readonly account: string;
  readonly authText: string;
}

function opencodeLabel(
  vaultEntries: readonly VaultEntry[],
  accountId: string,
  authText: string,
): string {
  const entry = vaultEntries.find(
    (candidate) => candidate.agent === OPENCODE_AGENT && candidate.accountId === accountId,
  );
  return formatOpencodeAccountLabel(
    accountId,
    entry?.alias ?? null,
    entry?.email ?? readOpencodeDisplayEmail(authText),
  );
}

/**
 * The live credential set plus every stored one, each read exactly once
 * per load. Reading the file here (rather than inside each adapter) is
 * what keeps one load's readings consistent: a set that is swapped
 * mid-load cannot have half its providers attributed to the new
 * identity and half to the old.
 */
function listOpencodeBundles(
  vault: AccountVault,
  authPath: string = defaultOpencodeAuthPath(),
): OpencodeBundle[] {
  const entries = vault.list();
  const bundles = new Map<string, OpencodeBundle>();
  try {
    const text = readFileSync(authPath, 'utf8');
    if (text.length > 0 && readOpencodeProviders(text).length > 0) {
      const accountId = opencodeAccountId(text);
      bundles.set(accountId, {
        accountId,
        account: opencodeLabel(entries, accountId, text),
        authText: text,
      });
    }
  } catch {
    // no live credential set is not an error; stored ones still count
  }
  for (const entry of entries) {
    if (entry.agent !== OPENCODE_AGENT || bundles.has(entry.accountId)) {
      continue;
    }
    let authText: string | null = null;
    try {
      authText = vault.loadCredentials(entry.agent, entry.accountId);
    } catch {
      // an unreadable stored set simply yields no quota reading
    }
    if (authText === null) {
      continue;
    }
    bundles.set(entry.accountId, {
      accountId: entry.accountId,
      account: opencodeLabel(entries, entry.accountId, authText),
      authText,
    });
  }
  return [...bundles.values()];
}

/** Groups bundles by the key they hold for one provider, without the key in the map. */
function groupByProviderKey(
  bundles: readonly OpencodeBundle[],
  providerId: string,
): { readonly apiKey: string; readonly bundles: OpencodeBundle[] }[] {
  const groups = new Map<string, { apiKey: string; bundles: OpencodeBundle[] }>();
  for (const bundle of bundles) {
    const apiKey = readOpencodeApiKey(bundle.authText, providerId);
    if (apiKey === null) {
      continue;
    }
    const fingerprint = accessTokenFingerprint(apiKey);
    const group = groups.get(fingerprint);
    if (group === undefined) {
      groups.set(fingerprint, { apiKey, bundles: [bundle] });
    } else {
      group.bundles.push(bundle);
    }
  }
  return [...groups.values()];
}

/**
 * OpenCode Go readings, one vendor call per distinct key. Two stored
 * sets that carry the same key are the same subscription, so they share
 * the reading — but each row keeps its own identity, because the user
 * switches between sets, not between subscriptions.
 */
async function loadOpencodeGoQuota(
  bundles: readonly OpencodeBundle[],
  nowUtc: number,
  stateStore: QuotaFetchStateStore | null,
  stateStoreUnavailable: boolean,
): Promise<QuotaSnapshot[]> {
  const readings = await Promise.all(
    groupByProviderKey(bundles, OPENCODE_GO_PROVIDER).map(async ({ apiKey, bundles: group }) => {
      const owner = group[0];
      if (owner === undefined) {
        return [];
      }
      const snapshot = await throttledQuota(
        opencodeGoQuotaSubject({
          apiKey,
          accountId: owner.accountId,
          account: owner.account,
        }),
        nowUtc,
        () =>
          fetchOpencodeGoQuota({
            apiKey,
            accountId: owner.accountId,
            account: owner.account,
            nowUtc,
          }),
        {
          ttlSeconds: SUBSCRIPTION_CADENCE_SECONDS,
          stateStore,
          stateStoreUnavailable,
        },
      );
      return group.map((bundle) => ({
        ...snapshot,
        accountId: bundle.accountId,
        account: bundle.account,
      }));
    }),
  );
  return readings.flat();
}

/**
 * ClinePass readings. Unlike OpenCode Go these carry a real vendor
 * subject (the Cline user id), so the reading names its own account and
 * two credential sets belonging to one Cline user collapse into one row
 * downstream instead of being duplicated per bundle.
 */
async function loadClineQuota(
  bundles: readonly OpencodeBundle[],
  nowUtc: number,
  stateStore: QuotaFetchStateStore | null,
  stateStoreUnavailable: boolean,
): Promise<QuotaSnapshot[]> {
  return Promise.all(
    groupByProviderKey(bundles, CLINE_PASS_PROVIDER).map(({ apiKey, bundles: group }) => {
      // names a failure that happens before the vendor account is known,
      // so an unusable stored key does not show up as "(current login)"
      const credentialLabel = group[0]?.account ?? null;
      return throttledQuota(
        clinePassQuotaSubject({ apiKey, accountId: null, account: credentialLabel }),
        nowUtc,
        () => fetchClinePassQuota({ apiKey, nowUtc, credentialLabel }),
        {
          ttlSeconds: SUBSCRIPTION_CADENCE_SECONDS,
          stateStore,
          stateStoreUnavailable,
        },
      );
    }),
  );
}

/**
 * One row per Grok login. The token is read from `auth.json` on every
 * pass rather than held: the Grok CLI renews it in place, so a cached
 * copy would go stale mid-session (and llmtally must never renew it
 * itself — that would rotate the lineage out from under the CLI).
 */
async function loadGrokQuota(
  nowUtc: number,
  stateStore: QuotaFetchStateStore | null,
  stateStoreUnavailable: boolean,
  authPath: string | undefined,
): Promise<QuotaSnapshot[]> {
  const credentials =
    authPath === undefined ? defaultGrokCredentials() : readGrokCredentials(authPath);
  return Promise.all(
    credentials.map((credential) =>
      throttledQuota(
        grokQuotaSubject({
          accessToken: credential.accessToken,
          accountId: credential.accountId,
          account: credential.account,
        }),
        nowUtc,
        () => fetchGrokQuota({ credential, nowUtc }),
        {
          ttlSeconds: SUBSCRIPTION_CADENCE_SECONDS,
          stateStore,
          stateStoreUnavailable,
        },
      ),
    ),
  );
}

/** Windows beat no windows; then fresher wins; then the better source. */
const SOURCE_RANK: Record<QuotaSnapshot['source'], number> = {
  vendor_api: 3,
  stored_history: 2,
  third_party_cache: 1,
  source_log: 0,
};

function preferredSnapshot(a: QuotaSnapshot, b: QuotaSnapshot): QuotaSnapshot {
  if (a.windows.length === 0 !== (b.windows.length === 0)) {
    return a.windows.length > 0 ? a : b;
  }
  if (a.observedAtUtc !== b.observedAtUtc) {
    return a.observedAtUtc > b.observedAtUtc ? a : b;
  }
  return SOURCE_RANK[a.source] >= SOURCE_RANK[b.source] ? a : b;
}

/**
 * One account should appear once. The stable account id is the merge
 * key when both sides carry one; the display label only merges rows
 * that never got an id. Rows with neither are kept as-is.
 */
export function dedupeByAccount(snapshots: readonly QuotaSnapshot[]): QuotaSnapshot[] {
  const result: QuotaSnapshot[] = [];
  const indexByKey = new Map<string, number>();
  for (const snapshot of snapshots) {
    const key =
      snapshot.accountId !== null
        ? `${snapshot.agent}|id=${snapshot.accountId}`
        : snapshot.account !== null
          ? `${snapshot.agent}|label=${snapshot.account}`
          : null;
    if (key === null) {
      result.push(snapshot);
      continue;
    }
    const at = indexByKey.get(key);
    if (at === undefined) {
      indexByKey.set(key, result.length);
      result.push(snapshot);
      continue;
    }
    const current = result[at];
    if (current === undefined) {
      continue;
    }
    const winner = preferredSnapshot(current, snapshot);
    const loser = winner === current ? snapshot : current;
    const carried = loser.windows.length === 0 ? loser.warnings : [];
    // a windowless failed read that is at least as fresh as the winner
    // is the CURRENT state of this account: its typed failure rides
    // along with the winner's numbers instead of degrading to a warning
    const freshFailure =
      loser.failure !== null &&
      loser.windows.length === 0 &&
      loser.observedAtUtc >= winner.observedAtUtc
        ? loser
        : null;
    let merged = winner;
    if (freshFailure !== null) {
      merged = {
        ...merged,
        failure: freshFailure.failure,
        rateLimited: freshFailure.rateLimited,
        retryAfterSeconds: freshFailure.retryAfterSeconds,
      };
    }
    result[at] =
      carried.length === 0 ? merged : { ...merged, warnings: [...merged.warnings, ...carried] };
  }
  return result;
}

/**
 * Every antigravity account in the store gets its own reading (the
 * store is read-only for us; "switching" happens inside the IDE). Each
 * account is throttled independently so one refresh cannot starve the
 * others. An empty store degrades to the single legacy warning snapshot.
 */
async function loadAntigravityQuota(
  nowUtc: number,
  allowRefresh: boolean | undefined,
): Promise<QuotaSnapshot[]> {
  let accounts: readonly { readonly email: string }[] = [];
  try {
    accounts = listAntigravityAccounts(defaultAntigravityStoreDir());
  } catch {
    // an unreadable store reads as empty
  }
  if (accounts.length === 0) {
    return [
      await throttledQuota('antigravity', nowUtc, () =>
        readAntigravityQuota({ nowUtc, allowRefresh }),
      ),
    ];
  }
  return Promise.all(
    accounts.map((account) =>
      throttledQuota(
        {
          key: `antigravity:${account.email}`,
          agent: 'antigravity',
          accountId: account.email,
          account: account.email,
        },
        nowUtc,
        () => readAntigravityQuota({ nowUtc, allowRefresh, accountEmail: account.email }),
      ),
    ),
  );
}

/**
 * The active codex account, budgeted under its own key. `auth` is read
 * once by the caller and shared with the stored-account pass so the two
 * cannot disagree about which account is active — a disagreement there
 * leaves one account read by nobody. Null when codex has no login at
 * all, which the throttle has nothing to cache for.
 */
async function throttledCodexLive(
  auth: CodexAuth | null,
  nowUtc: number,
): Promise<QuotaSnapshot | null> {
  if (auth === null) {
    return null;
  }
  return throttledQuota(codexQuotaSubject(auth.accountId, auth.email), nowUtc, async () =>
    fetchCodexUsage({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      account: auth.email,
      nowUtc,
    }),
  );
}

/**
 * One reading per codex account the vault holds that is not the one
 * auth.json currently names. Each is throttled under its own key so a
 * backoff on one account never starves the others, and each failure is
 * attributed to the entry it belongs to rather than borrowing another
 * account's numbers.
 */
async function loadStoredCodexQuota(
  vault: AccountVault,
  activeAccountId: string | null,
  nowUtc: number,
  allowRefresh: boolean | undefined,
): Promise<QuotaSnapshot[]> {
  const targets = vault
    .list()
    .filter((entry) => entry.agent === 'codex' && entry.accountId !== activeAccountId);
  return Promise.all(
    targets.map(async (entry) =>
      throttledQuota(
        // the same key the live pass uses, so an account keeps one
        // budget across going active and inactive
        codexQuotaSubject(entry.accountId, entry.email ?? entry.accountId),
        nowUtc,
        async () => {
          const [snapshot] = await readVaultCodexQuota({
            vault,
            activeAccountId,
            nowUtc,
            only: entry.accountId,
            allowRefresh,
          });
          return (
            snapshot ??
            makeQuotaSnapshot({
              agent: 'codex',
              accountId: entry.accountId,
              account: entry.email ?? entry.accountId,
              source: 'vendor_api',
              observedAtUtc: nowUtc,
              windows: [],
              failure: { kind: 'unavailable', failedAtUtc: nowUtc, retryAtUtc: null },
              warnings: ['stored account produced no reading'],
            })
          );
        },
      ),
    ),
  );
}

/**
 * Live wins when it produced windows; otherwise the rollout-log
 * snapshot is used and the live failure is kept as a warning so the
 * fallback is visible rather than silent.
 */
function codexSnapshot(live: QuotaSnapshot | null, nowUtc: number): QuotaSnapshot {
  if (live !== null && live.windows.length > 0) {
    return live;
  }
  const logs = readCodexQuota({ nowUtc });
  if (live === null) {
    return logs;
  }
  return {
    ...logs,
    accountId: logs.accountId ?? live.accountId,
    account: logs.account ?? live.account,
    // the fallback stands in for a read that failed just now; that
    // typed failure is the row's current state, not a mere footnote
    failure: live.failure ?? logs.failure,
    rateLimited: live.rateLimited || logs.rateLimited,
    retryAfterSeconds: live.retryAfterSeconds ?? logs.retryAfterSeconds,
    warnings: [...live.warnings, ...logs.warnings],
  };
}

/** Persistence must never break a quota read; all failures degrade silently. */
function withQuotaHistory(
  snapshots: readonly QuotaSnapshot[],
  databasePath: string,
  nowUtc: number,
): QuotaSnapshot[] {
  try {
    const db = openDatabase(databasePath);
    try {
      migrate(db);
      recordQuotaSamples(db, snapshots, nowUtc);
      return snapshots.map((snapshot) => {
        if (snapshot.windows.length > 0) {
          return snapshot;
        }
        const rejectionNotes: string[] = [];
        const stored = readStoredLastGood(
          db,
          {
            agent: snapshot.agent,
            accountId: snapshot.accountId,
            account: snapshot.account,
            nowUtc,
            failure: snapshot.failure,
          },
          rejectionNotes,
        );
        if (stored === null) {
          return rejectionNotes.length === 0
            ? snapshot
            : { ...snapshot, warnings: [...snapshot.warnings, ...rejectionNotes] };
        }
        return {
          ...stored,
          plan: snapshot.plan,
          failure: snapshot.failure,
          rateLimited: snapshot.rateLimited,
          retryAfterSeconds: snapshot.retryAfterSeconds,
          warnings: [...snapshot.warnings, ...stored.warnings],
        };
      });
    } finally {
      db.close();
    }
  } catch (error) {
    // still surface that history is not being recorded (once, on the first snapshot)
    const detail = error instanceof Error ? error.message : String(error);
    return snapshots.map((snapshot, index) =>
      index === 0
        ? { ...snapshot, warnings: [...snapshot.warnings, `quota history unavailable: ${detail}`] }
        : snapshot,
    );
  }
}
