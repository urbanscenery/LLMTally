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
import { resolveActiveClaudeContext, recaptureRefreshDeadActiveAccount } from '../accounts/active-claude.ts';
import type { ActiveClaudeContext } from '../accounts/active-claude.ts';
import { createActiveCredentialStore } from '../accounts/credentials.ts';
import type { ActiveCredentialStore } from '../accounts/credentials.ts';
import { AccountVault } from '../accounts/vault.ts';
import { readVaultAccountsQuota } from './vault-accounts.ts';
import { openDatabase } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';
import {
  defaultAntigravityStoreDir,
  listAntigravityAccounts,
  readAntigravityQuota,
} from './antigravity.ts';
import { fetchCodexLiveQuota } from './codex-live.ts';
import {
  defaultClaudeTokenReader,
  fetchClaudeQuota,
  makeQuotaSnapshot,
  readCodexQuota,
} from './providers.ts';
import type { QuotaSnapshot } from './providers.ts';
import { openQuotaFetchStateStore } from './fetch-state.ts';
import type { QuotaFetchStateStore, QuotaThrottleSubject } from './fetch-state.ts';
import { readStoredLastGood, recordQuotaSamples } from './store.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';
import { claudeQuotaSubject, throttledQuota } from './throttle.ts';

export type QuotaAgentFilter = 'claude-code' | 'codex' | 'antigravity' | null;

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
} = {}): Promise<QuotaSnapshot[]> {
  const agent = options.agent ?? null;
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const vault = options.vault ?? new AccountVault();
  const context = options.activeContext ?? resolveActiveClaudeContext({ vault });

  if (options.allowRefresh !== false) {
    try {
      recaptureRefreshDeadActiveAccount({
        context,
        vault,
        activeStore: options.activeStore ?? createActiveCredentialStore(),
        nowUtc: now,
      });
    } catch {
      // self-healing is opportunistic; quota display must not depend on it
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

  try {
    const [claude, codexLive, antigravity] = await Promise.all([
      agent === null || agent === 'claude-code'
        ? loadActiveClaudeQuota(context, now, stateStore, stateStoreUnavailable)
        : null,
      agent === null || agent === 'codex' ? throttledCodexLive(now) : null,
      agent === null || agent === 'antigravity'
        ? loadAntigravityQuota(now, options.allowRefresh)
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
                storedAccountSubject(entry.accountId, entry.email),
                now,
                async () => {
                  const [snapshot] = await readVaultAccountsQuota({
                    vault,
                    activeContext: context,
                    nowUtc: now,
                    only: entry.accountId,
                    allowRefresh: options.allowRefresh,
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
    }
    if (antigravity !== null) {
      snapshots.push(...antigravity);
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
 * The live account's budget key follows its access token (a rotation =
 * a fresh vendor budget); stored accounts are keyed per account id —
 * conservative across our own refresh rotations, which only ever
 * under-spends.
 */
function storedAccountSubject(accountId: string, email: string | null): QuotaThrottleSubject {
  return {
    key: `claude-code|ua=${LLMTALLY_USER_AGENT}|acct=${accountId}`,
    agent: 'claude-code',
    accountId,
    account: email ?? accountId,
  };
}

async function loadActiveClaudeQuota(
  context: ActiveClaudeContext,
  now: number,
  stateStore: QuotaFetchStateStore | null,
  stateStoreUnavailable: boolean,
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
  // the token is read once per load: it names the budget key and is
  // then injected into the fetch so the two can never disagree
  const token = defaultClaudeTokenReader()();
  const accountId = context.activeAccountId;
  const account = context.identity?.email ?? null;
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
    result[at] =
      carried.length === 0 ? winner : { ...winner, warnings: [...winner.warnings, ...carried] };
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

/** Codex may have no credentials at all, which the throttle cannot cache. */
async function throttledCodexLive(nowUtc: number): Promise<QuotaSnapshot | null> {
  let unavailable = false;
  const snapshot = await throttledQuota('codex', nowUtc, async () => {
    const live = await fetchCodexLiveQuota({ nowUtc });
    if (live === null) {
      unavailable = true;
      return makeQuotaSnapshot({
        agent: 'codex',
        source: 'vendor_api',
        observedAtUtc: nowUtc,
        windows: [],
      });
    }
    return live;
  });
  return unavailable ? null : snapshot;
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
        const stored = readStoredLastGood(db, {
          agent: snapshot.agent,
          accountId: snapshot.accountId,
          account: snapshot.account,
          nowUtc,
          failure: snapshot.failure,
        });
        if (stored === null) {
          return snapshot;
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
