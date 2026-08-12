/**
 * Persistent, cross-process quota fetch state. The vendor's usage
 * endpoint budgets requests per access token on a rolling hour, and
 * that budget is shared by every llmtally process past and present —
 * so the cadence bookkeeping cannot live in process memory.
 *
 * The core is an atomic claim: inside one BEGIN IMMEDIATE transaction
 * a caller either reserves the next fetch slot (stamping
 * `last_fetch_utc` + a bounded `claim_*` lease) or learns exactly when
 * to come back. Only the claim winner performs the HTTP request; the
 * slot is spent even if the process crashes mid-fetch, which
 * deliberately fails toward under-spending the budget.
 */
import { openDatabase } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';

export interface QuotaThrottleSubject {
  /** Budget key: `agent|ua=…|token=sha256:…` — never a raw secret. */
  readonly key: string;
  readonly agent: string;
  readonly accountId: string | null;
  readonly account: string | null;
}

export interface QuotaFetchState {
  readonly key: string;
  readonly agent: string;
  readonly accountId: string | null;
  readonly accountLabel: string | null;
  readonly blockedUntilUtc: number;
  readonly consecutive429: number;
  readonly last429Utc: number | null;
  readonly lastFetchUtc: number;
  /**
   * When the vendor last refused this credential (401/403), or null.
   * Set, the credential's remembered numbers are not to be shown by
   * anyone — including a process that has never talked to the vendor.
   */
  readonly authInvalidAtUtc: number | null;
  readonly claimOwner: string | null;
  readonly claimUntilUtc: number | null;
  readonly updatedAtUtc: number;
}

export type QuotaClaimDecision =
  | { readonly kind: 'claimed'; readonly owner: string; readonly state: QuotaFetchState }
  | {
      readonly kind: 'deferred';
      readonly reason: 'claim' | 'cadence' | 'rate_limit';
      readonly retryAtUtc: number;
      readonly state: QuotaFetchState;
    };

export type QuotaFetchCompletion =
  /**
   * A successful read is the only thing that knows whose numbers these
   * were. Some vendors only reveal that during the call (ClinePass
   * resolves `/users/me`), so the identity is recorded here and reused
   * to label reads that never get to make the call.
   */
  | { readonly kind: 'success'; readonly accountId?: string | null; readonly account?: string | null }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | null }
  /** The vendor refused the credential itself; remembered numbers die with it. */
  | { readonly kind: 'auth_invalid' }
  | { readonly kind: 'failure' };

export interface QuotaFetchStateStore {
  claim(
    subject: QuotaThrottleSubject,
    nowUtc: number,
    normalIntervalSeconds: number,
    post429IntervalSeconds: number,
  ): QuotaClaimDecision;
  complete(key: string, owner: string, nowUtc: number, completion: QuotaFetchCompletion): void;
  close(): void;
}

/** Bounded fetch lease; a crashed claimer ages out after this. */
const CLAIM_TTL_SECONDS = 30;
/** How long a 429 keeps governing cadence (the endpoint's rolling hour). */
export const POST_429_WINDOW_SECONDS = 3600;
/** Minimum interval while a 429 governs the rolling hour. */
export const POST_429_MIN_INTERVAL_SECONDS = 360;
/** First-429 exponential base and its cap. */
const BACKOFF_BASE_SECONDS = 5 * 60;
const BACKOFF_CAP_SECONDS = 30 * 60;
/**
 * Ceiling on a vendor's own `retry-after`. The wait is persisted, so an
 * absurd hint (a misbehaving or compromised endpoint asking for days)
 * would park that vendor's polling long past any restart. Honouring it
 * up to an hour keeps the vendor in charge of realistic waits; past
 * that we retry, and a still-refusing endpoint just 429s us again.
 */
const RETRY_AFTER_CAP_SECONDS = 3600;
const STATE_RETENTION_SECONDS = 7 * 24 * 3600;

/**
 * Wait after the `count`-th consecutive 429. The single source for
 * both the persistent state machine and the in-memory throttle — the
 * two must never disagree about how long a refusal holds.
 */
export function rateLimitWaitSeconds(count: number, retryAfterSeconds: number | null): number {
  const exponential = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (count - 1));
  const hinted = Math.min(retryAfterSeconds ?? 0, RETRY_AFTER_CAP_SECONDS);
  return Math.max(POST_429_MIN_INTERVAL_SECONDS, exponential, hinted);
}

interface StateRow {
  readonly key: string;
  readonly agent: string;
  readonly account_id: string | null;
  readonly account_label: string | null;
  readonly blocked_until_utc: number;
  readonly consecutive_429: number;
  readonly last_429_utc: number | null;
  readonly last_fetch_utc: number;
  readonly auth_invalid_at_utc: number | null;
  readonly claim_owner: string | null;
  readonly claim_until_utc: number | null;
  readonly updated_at_utc: number;
}

function toState(row: StateRow): QuotaFetchState {
  return {
    key: row.key,
    agent: row.agent,
    accountId: row.account_id,
    accountLabel: row.account_label,
    blockedUntilUtc: row.blocked_until_utc,
    consecutive429: row.consecutive_429,
    last429Utc: row.last_429_utc,
    lastFetchUtc: row.last_fetch_utc,
    authInvalidAtUtc: row.auth_invalid_at_utc,
    claimOwner: row.claim_owner,
    claimUntilUtc: row.claim_until_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

export function openQuotaFetchStateStore(
  databasePath: string,
  nowUtc: number,
): QuotaFetchStateStore {
  const db = openDatabase(databasePath);
  try {
    migrate(db);
    // retention prune; a row under a live claim is never removed
    db.run(
      `DELETE FROM quota_fetch_state
       WHERE updated_at_utc < ?
         AND (claim_until_utc IS NULL OR claim_until_utc <= ?)`,
      [nowUtc - STATE_RETENTION_SECONDS, nowUtc],
    );
  } catch (error) {
    db.close();
    throw error;
  }

  const selectRow = db.prepare<StateRow, [string]>(
    `SELECT key, agent, account_id, account_label, blocked_until_utc, consecutive_429,
            last_429_utc, last_fetch_utc, auth_invalid_at_utc,
            claim_owner, claim_until_utc, updated_at_utc
     FROM quota_fetch_state WHERE key = ?`,
  );

  function readRow(key: string): StateRow | null {
    return selectRow.get(key);
  }

  return {
    claim(subject, nowUtc_, normalIntervalSeconds, post429IntervalSeconds): QuotaClaimDecision {
      const owner = `${process.pid}:${Bun.randomUUIDv7().slice(-8)}`;
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.run(
          `INSERT INTO quota_fetch_state
             (key, agent, account_id, account_label, blocked_until_utc, consecutive_429,
              last_429_utc, last_fetch_utc, auth_invalid_at_utc,
              claim_owner, claim_until_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, 0, 0, NULL, 0, NULL, NULL, NULL, ?)
           ON CONFLICT (key) DO NOTHING`,
          [subject.key, subject.agent, subject.accountId, subject.account, nowUtc_],
        );
        const row = readRow(subject.key);
        if (row === null) {
          throw new Error(`quota_fetch_state row vanished for ${subject.key}`);
        }
        const post429Active =
          row.last_429_utc !== null && nowUtc_ - row.last_429_utc < POST_429_WINDOW_SECONDS;
        const effectiveInterval = post429Active
          ? post429IntervalSeconds
          : normalIntervalSeconds;
        const cadenceAt = row.last_fetch_utc + effectiveInterval;
        const liveClaim = row.claim_owner !== null && (row.claim_until_utc ?? 0) > nowUtc_;
        const claimAt = liveClaim ? (row.claim_until_utc ?? 0) : 0;
        const retryAtUtc = Math.max(row.blocked_until_utc, cadenceAt, claimAt);

        if (nowUtc_ < retryAtUtc) {
          db.exec('COMMIT;');
          // rate_limit outranks claim outranks cadence: report the
          // strongest condition, not the latest timestamp. A deferral
          // whose interval is stretched by a recent 429 IS rate limiting
          // — a restarted process must keep saying so, or the stored
          // history loses the 429-based trust extension it still earns.
          const reason =
            row.blocked_until_utc > nowUtc_ || post429Active
              ? 'rate_limit'
              : liveClaim
                ? 'claim'
                : 'cadence';
          return { kind: 'deferred', reason, retryAtUtc, state: toState(row) };
        }

        // A subject names its budget, not always its account: a vendor
        // whose identity only arrives with the response passes null (or
        // a credential label) here. Once a read has recorded the real
        // id, the placeholder must not overwrite it, or the row loses
        // the only link between this budget and its stored history.
        const updated = db.run(
          `UPDATE quota_fetch_state
           SET agent = ?,
               account_id = COALESCE(account_id, ?),
               account_label = CASE WHEN account_id IS NULL THEN ? ELSE account_label END,
               blocked_until_utc = CASE WHEN blocked_until_utc <= ? THEN 0 ELSE blocked_until_utc END,
               consecutive_429 = CASE
                 WHEN last_429_utc IS NULL OR ? - last_429_utc >= ${POST_429_WINDOW_SECONDS}
                   THEN 0 ELSE consecutive_429 END,
               last_429_utc = CASE
                 WHEN last_429_utc IS NULL OR ? - last_429_utc >= ${POST_429_WINDOW_SECONDS}
                   THEN NULL ELSE last_429_utc END,
               last_fetch_utc = ?,
               claim_owner = ?, claim_until_utc = ?, updated_at_utc = ?
           WHERE key = ?
             AND (claim_owner IS NULL OR claim_until_utc <= ?)
             AND blocked_until_utc <= ?
             AND last_fetch_utc + ? <= ?`,
          [
            subject.agent,
            subject.accountId,
            subject.account,
            nowUtc_,
            nowUtc_,
            nowUtc_,
            nowUtc_,
            owner,
            nowUtc_ + CLAIM_TTL_SECONDS,
            nowUtc_,
            subject.key,
            nowUtc_,
            nowUtc_,
            effectiveInterval,
            nowUtc_,
          ],
        );
        if (Number(updated.changes) !== 1) {
          // raced inside the transaction window is impossible under
          // IMMEDIATE, but the guard keeps the invariant explicit
          const current = readRow(subject.key) ?? row;
          db.exec('COMMIT;');
          const stillLive =
            current.claim_owner !== null && (current.claim_until_utc ?? 0) > nowUtc_;
          const stillPost429 =
            current.last_429_utc !== null &&
            nowUtc_ - current.last_429_utc < POST_429_WINDOW_SECONDS;
          return {
            kind: 'deferred',
            reason:
              current.blocked_until_utc > nowUtc_ || stillPost429
                ? 'rate_limit'
                : stillLive
                  ? 'claim'
                  : 'cadence',
            retryAtUtc: Math.max(
              current.blocked_until_utc,
              current.last_fetch_utc + effectiveInterval,
              stillLive ? (current.claim_until_utc ?? 0) : 0,
            ),
            state: toState(current),
          };
        }
        const claimed = readRow(subject.key);
        db.exec('COMMIT;');
        if (claimed === null) {
          throw new Error(`quota_fetch_state row vanished for ${subject.key}`);
        }
        return { kind: 'claimed', owner, state: toState(claimed) };
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // already committed or connection gone
        }
        throw error;
      }
    },

    complete(key, owner, nowUtc_, completion): void {
      db.exec('BEGIN IMMEDIATE;');
      try {
        if (completion.kind === 'success') {
          db.run(
            `UPDATE quota_fetch_state
             SET account_id = COALESCE(?, account_id),
                 account_label = COALESCE(?, account_label),
                 blocked_until_utc = 0,
                 consecutive_429 = CASE
                   WHEN last_429_utc IS NOT NULL AND ? - last_429_utc < ${POST_429_WINDOW_SECONDS}
                     THEN consecutive_429 ELSE 0 END,
                 last_429_utc = CASE
                   WHEN last_429_utc IS NOT NULL AND ? - last_429_utc < ${POST_429_WINDOW_SECONDS}
                     THEN last_429_utc ELSE NULL END,
                 auth_invalid_at_utc = NULL,
                 claim_owner = NULL, claim_until_utc = NULL, updated_at_utc = ?
             WHERE key = ? AND claim_owner = ?`,
            [
              completion.accountId ?? null,
              completion.account ?? null,
              nowUtc_,
              nowUtc_,
              nowUtc_,
              key,
              owner,
            ],
          );
        } else if (completion.kind === 'auth_invalid') {
          // the slot stays spent and the refusal is recorded, so a
          // deferred read in any process knows not to serve history
          db.run(
            `UPDATE quota_fetch_state
             SET auth_invalid_at_utc = ?,
                 claim_owner = NULL, claim_until_utc = NULL, updated_at_utc = ?
             WHERE key = ? AND claim_owner = ?`,
            [nowUtc_, nowUtc_, key, owner],
          );
        } else if (completion.kind === 'rate_limited') {
          // a 429 is applied monotonically whoever reports it: the
          // refusal spent real budget even if the claim already aged
          // out — and a stale reporter's older clock must never move
          // last_429/updated_at backwards and shorten the window
          const row = selectRow.get(key);
          if (row !== null) {
            // a late reporter's clock may be older than the newest 429
            // on the row: anchor the block at the newest evidence so a
            // stale completion can only extend the wait, never shrink it
            const effective429At = Math.max(nowUtc_, row.last_429_utc ?? 0);
            const withinWindow =
              row.last_429_utc !== null &&
              effective429At - row.last_429_utc < POST_429_WINDOW_SECONDS;
            const nextCount = (withinWindow ? row.consecutive_429 : 0) + 1;
            const wait = rateLimitWaitSeconds(nextCount, completion.retryAfterSeconds);
            db.run(
              `UPDATE quota_fetch_state
               SET blocked_until_utc = MAX(blocked_until_utc, ?),
                   consecutive_429 = MAX(consecutive_429, ?),
                   last_429_utc = MAX(COALESCE(last_429_utc, 0), ?),
                   claim_owner = CASE WHEN claim_owner = ? THEN NULL ELSE claim_owner END,
                   claim_until_utc = CASE WHEN claim_owner = ? THEN NULL ELSE claim_until_utc END,
                   updated_at_utc = MAX(updated_at_utc, ?)
               WHERE key = ?`,
              [effective429At + wait, nextCount, nowUtc_, owner, owner, nowUtc_, key],
            );
          }
        } else {
          // transport failure: release the claim, keep the spent slot
          db.run(
            `UPDATE quota_fetch_state
             SET claim_owner = NULL, claim_until_utc = NULL, updated_at_utc = ?
             WHERE key = ? AND claim_owner = ?`,
            [nowUtc_, key, owner],
          );
        }
        db.exec('COMMIT;');
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // already committed or connection gone
        }
        throw error;
      }
    },

    close(): void {
      db.close();
    },
  };
}
