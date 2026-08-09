/**
 * Composes all quota sources into one snapshot list for the TUI: the
 * account that is logged in right now plus every other account stored
 * in the vault, each read with its own token.
 *
 * With a database path, successful readings are persisted as history
 * samples (best-effort) and empty snapshots are backfilled from the
 * stored last-good reading (marked `stored_history`, never fabricated).
 */
import { AccountVault } from '../accounts/vault.ts';
import { readVaultAccountsQuota } from './vault-accounts.ts';
import { openDatabase } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';
import { readAntigravityQuota } from './antigravity.ts';
import { fetchCodexLiveQuota } from './codex-live.ts';
import { fetchClaudeQuota, makeQuotaSnapshot, readCodexQuota } from './providers.ts';
import type { QuotaSnapshot } from './providers.ts';
import { readStoredLastGood, recordQuotaSamples } from './store.ts';
import { throttledQuota } from './throttle.ts';

export type QuotaAgentFilter = 'claude-code' | 'codex' | 'antigravity' | null;

export async function loadAllQuota(options: {
  readonly agent?: QuotaAgentFilter;
  readonly nowUtc?: number;
  /** Ledger path for sample recording + stored fallback; omit to stay stateless. */
  readonly databasePath?: string;
  /** false = never call OAuth token endpoints (pure read-only mode). */
  readonly allowRefresh?: boolean;
  /** Injected in tests; production opens the real vault. */
  readonly vault?: AccountVault;
} = {}): Promise<QuotaSnapshot[]> {
  const agent = options.agent ?? null;
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);

  // independent network sources run in parallel (each degrades to
  // warnings); the throttle reuses a recent reading and holds off after
  // a 429 instead of hammering the endpoint that just refused us
  const [claude, codexLive, antigravity] = await Promise.all([
    agent === null || agent === 'claude-code'
      ? throttledQuota('claude-code', now, () => fetchClaudeQuota({ nowUtc: now }))
      : null,
    agent === null || agent === 'codex'
      ? throttledCodexLive(now)
      : null,
    agent === null || agent === 'antigravity'
      ? throttledQuota('antigravity', now, () =>
          readAntigravityQuota({ nowUtc: now, allowRefresh: options.allowRefresh }),
        )
      : null,
  ]);

  const snapshots: QuotaSnapshot[] = [];
  if (claude !== null) {
    snapshots.push(claude);
    // every stored account is read live with its own token, so an
    // account we hold no credentials for simply has no reading
    const vault = options.vault ?? new AccountVault();
    try {
      const stored = await Promise.all(
        vault
          .list()
          .filter((entry) => entry.agent === 'claude-code' && entry.accountId !== vault.activeAccountId())
          .map(async (entry) =>
            throttledQuota(`claude-code:${entry.accountId}`, now, async () => {
              const [snapshot] = await readVaultAccountsQuota({
                vault,
                nowUtc: now,
                only: entry.accountId,
                allowRefresh: options.allowRefresh,
              });
              return snapshot ?? claude;
            }),
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
    snapshots.push(antigravity);
  }
  const withHistory =
    options.databasePath === undefined
      ? snapshots
      : withQuotaHistory(snapshots, options.databasePath, now);
  return dedupeByAccount(withHistory);
}

const SOURCE_RANK: Record<QuotaSnapshot['source'], number> = {
  vendor_api: 3,
  stored_history: 2,
  third_party_cache: 1,
  source_log: 0,
};

/** Windows beat no windows; then fresher wins; then the better source. */
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
 * One account should appear once. When live fails we deliberately keep
 * the cached/stored rows, which can leave the same account represented
 * twice with different ages; the freshest reading wins and a dropped
 * row only contributes its warnings when it had nothing else to say.
 * Rows without an account label are never merged.
 */
export function dedupeByAccount(snapshots: readonly QuotaSnapshot[]): QuotaSnapshot[] {
  const result: QuotaSnapshot[] = [];
  const indexByKey = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (snapshot.account === null) {
      result.push(snapshot);
      continue;
    }
    const key = `${snapshot.agent} ${snapshot.account}`;
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
        const stored = readStoredLastGood(db, snapshot.agent, snapshot.account, nowUtc);
        if (stored === null) {
          return snapshot;
        }
        return { ...stored, plan: snapshot.plan, warnings: [...snapshot.warnings, ...stored.warnings] };
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
