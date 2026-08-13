import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readClaudeActiveIdentity } from '../accounts/claude.ts';
import type { ClaudeActiveIdentity } from '../accounts/claude.ts';
import { asObject, asString } from '../parsers/shared.ts';
import { LLMTALLY_USER_AGENT } from '../version.ts';

const FETCH_TIMEOUT_MS = 3000;
const CODEX_RECENT_FILES = 5;
const CODEX_STALE_SECONDS = 15 * 60;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export interface QuotaWindow {
  readonly id: string;
  readonly usedPercent: number;
  readonly resetsAtUtc: number | null;
}

export type QuotaSource = 'vendor_api' | 'source_log' | 'third_party_cache' | 'stored_history';

/**
 * Why a reading has no (fresh) windows. `rate_limited` is the vendor's
 * 429; `transport` is any other network/HTTP/parse failure; `unavailable`
 * means we never had usable credentials; `deferred` means the throttle
 * chose not to call (cadence/backoff/another process holds the claim);
 * `auth_invalid` means the vendor rejected the credential we do have
 * (401) or refused the product to it (403).
 *
 * The split matters beyond wording: `auth_invalid` is the one kind that
 * must never be answered with remembered numbers. A 429 or a timeout
 * leaves the last reading true; a revoked key or a lapsed subscription
 * means nobody can vouch for it any more.
 *
 * `account_mismatch` is the split-brain state: the config names one
 * account but the live credential store provably holds another's bytes
 * (a running session's token refresh reverted a switch). The selected
 * account's stored last-good stays trustworthy — only the LIVE read is
 * refused, to keep the other account's usage off this one's row.
 */
export type QuotaFailureKind =
  | 'rate_limited'
  | 'transport'
  | 'unavailable'
  | 'deferred'
  | 'auth_invalid'
  | 'account_mismatch';

export interface QuotaFailure {
  readonly kind: QuotaFailureKind;
  readonly failedAtUtc: number;
  /** Earliest sensible retry, when one is known. */
  readonly retryAtUtc: number | null;
  /** account_mismatch only: profile-confirmed owner of the live bytes. */
  readonly credentialOwner?: {
    readonly accountId: string | null;
    readonly account: string | null;
  };
}

export interface QuotaSnapshot {
  readonly agent: string;
  /**
   * Stable vendor account id (Claude accountUuid); null when unknown.
   * The dedupe/binding key — labels stay display-only.
   */
  readonly accountId: string | null;
  /** Why the current read failed; null on a successful fresh reading. */
  readonly failure: QuotaFailure | null;
  /** Derived: `failure?.kind === 'rate_limited'`. Never set directly. */
  readonly rateLimited: boolean;
  /** Vendor-supplied hint in seconds, when it gave a usable one. */
  readonly retryAfterSeconds: number | null;
  /** Display label of the account this reading belongs to; null when unknown. */
  readonly account: string | null;
  readonly plan: string | null;
  readonly source: QuotaSource;
  readonly observedAtUtc: number;
  readonly windows: readonly QuotaWindow[];
  readonly warnings: readonly string[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type TokenReader = () => string | null;

/**
 * Reads the Claude Code OAuth access token the same way the CLI does
 * (Keychain, then the credentials file). The token is used for ONE
 * read-only usage request and is never written, refreshed, or logged.
 */
/** Absolute path so a PATH-planted `security` cannot intercept the read. */
const SECURITY_BIN = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 5000;

export function defaultClaudeTokenReader(home: string = homedir()): TokenReader {
  return () => {
    // macOS-only tool: on other platforms skip straight to the file so a
    // same-named binary elsewhere on PATH is never spawned
    if (process.platform === 'darwin') {
      try {
        const keychain = Bun.spawnSync(
          [SECURITY_BIN, 'find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { stdout: 'pipe', stderr: 'pipe', timeout: SECURITY_TIMEOUT_MS },
        );
        if (keychain.exitCode === 0) {
          const token = extractToken(keychain.stdout.toString());
          if (token !== null) {
            return token;
          }
        }
      } catch {
        // fall through to the credentials file
      }
    }
    try {
      return extractToken(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8'));
    } catch {
      return null;
    }
  };
}

function extractToken(raw: string): string | null {
  try {
    const parsed = asObject(JSON.parse(raw));
    const oauth = parsed === null ? null : asObject(parsed.claudeAiOauth);
    return oauth === null ? null : asString(oauth.accessToken);
  } catch {
    return null;
  }
}

/** Model-scoped weekly limits (`limits[]` in the usage response). */
function scopedLimitWindows(body: Record<string, unknown> | null): QuotaWindow[] {
  const limits = body === null ? null : body.limits;
  if (!Array.isArray(limits)) {
    return [];
  }
  const windows: QuotaWindow[] = [];
  for (const entry of limits) {
    const limit = asObject(entry);
    const scope = limit === null ? null : asObject(limit.scope);
    const model = scope === null ? null : asObject(scope.model);
    const name = model === null ? null : asString(model.display_name);
    const percent = limit?.percent;
    if (name === null || typeof percent !== 'number' || !Number.isFinite(percent)) {
      continue;
    }
    windows.push({ id: `7d ${name}`, usedPercent: percent, resetsAtUtc: parseIso(limit?.resets_at) });
  }
  return windows;
}

/** The paid overage axis; intentionally separate from window headroom. */
function extraUsageWindow(body: Record<string, unknown> | null): QuotaWindow | null {
  const extra = body === null ? null : asObject(body.extra_usage);
  if (extra === null || extra.is_enabled !== true) {
    return null;
  }
  const utilization = extra.utilization;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return null;
  }
  const used = extra.used_credits;
  const limit = extra.monthly_limit;
  const id =
    typeof used === 'number' && typeof limit === 'number' && Number.isFinite(used) && Number.isFinite(limit)
      ? `extra usage $${(used / 100).toFixed(0)}/$${(limit / 100).toFixed(0)}`
      : 'extra usage';
  return { id, usedPercent: utilization, resetsAtUtc: parseIso(extra.resets_at) };
}

export interface ClaudeUsageRequest {
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly account: string | null;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
}

/**
 * One read of the OAuth usage endpoint with a caller-supplied token, so
 * the same code serves the logged-in account and every stored one.
 */
export async function fetchClaudeUsage(request: ClaudeUsageRequest): Promise<QuotaSnapshot> {
  const { accessToken, accountId, account, nowUtc } = request;
  try {
    const fetchFn = request.fetchFn ?? fetch;
    const response = await fetchFn(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': LLMTALLY_USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : null;
      return makeQuotaSnapshot({
        agent: 'claude-code',
        source: 'vendor_api',
        observedAtUtc: nowUtc,
        windows: [],
        accountId,
        account,
        failure: {
          kind: 'rate_limited',
          failedAtUtc: nowUtc,
          retryAtUtc: retryAfterSeconds === null ? null : nowUtc + retryAfterSeconds,
        },
        retryAfterSeconds,
        warnings: ['claude usage endpoint returned 429 (rate limited)'],
      });
    }
    if (response.status === 401 || response.status === 403) {
      // a refused credential is an auth failure, not transport — the
      // distinction matters: transport keeps serving stored last-good
      // for up to a day, auth_invalid demands a reconnect and stops a
      // stale gauge from vouching for a login that no longer works
      return makeQuotaSnapshot({
        agent: 'claude-code',
        source: 'vendor_api',
        observedAtUtc: nowUtc,
        windows: [],
        accountId,
        account,
        failure: { kind: 'auth_invalid', failedAtUtc: nowUtc, retryAtUtc: null },
        warnings: [`claude usage endpoint refused the credential (http ${response.status})`],
      });
    }
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }
    const body = asObject(await response.json());
    const windows: QuotaWindow[] = [];
    for (const id of ['five_hour', 'seven_day', 'seven_day_opus'] as const) {
      const window = body === null ? null : asObject(body[id]);
      const used = window?.utilization;
      if (typeof used === 'number' && Number.isFinite(used)) {
        windows.push({ id, usedPercent: used, resetsAtUtc: parseIso(window?.resets_at) });
      }
    }
    windows.push(...scopedLimitWindows(body));
    const extra = extraUsageWindow(body);
    if (extra !== null) {
      windows.push(extra);
    }
    if (windows.length === 0) {
      // a real usage response always carries at least `five_hour`; a 2xx
      // that parses to nothing is schema drift (or an empty body), and
      // reporting it as success would replace good numbers with a blank
      // gauge instead of falling back to the last good reading
      return makeQuotaSnapshot({
        agent: 'claude-code',
        source: 'vendor_api',
        observedAtUtc: nowUtc,
        windows: [],
        accountId,
        account,
        failure: { kind: 'unavailable', failedAtUtc: nowUtc, retryAtUtc: null },
        warnings: ['claude usage response carried no recognizable windows (schema drift?)'],
      });
    }
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: nowUtc,
      windows,
      accountId,
      account,
    });
  } catch (error) {
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: nowUtc,
      windows: [],
      accountId,
      account,
      failure: { kind: 'transport', failedAtUtc: nowUtc, retryAtUtc: null },
      warnings: [
        `claude quota fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
  }
}

export async function fetchClaudeQuota(options: {
  readonly fetchFn?: FetchLike;
  readonly tokenReader?: TokenReader;
  readonly nowUtc?: number;
  /** Active identity for id + label; defaults to ~/.claude.json oauthAccount. */
  readonly identityReader?: () => ClaudeActiveIdentity | null;
}): Promise<QuotaSnapshot> {
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const identity = (options.identityReader ?? readClaudeActiveIdentity)();
  const accountId = identity?.accountUuid ?? null;
  const account = identity?.email ?? null;
  const token = (options.tokenReader ?? defaultClaudeTokenReader())();
  if (token === null) {
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: now,
      windows: [],
      accountId,
      account,
      failure: { kind: 'unavailable', failedAtUtc: now, retryAtUtc: null },
      warnings: ['no Claude Code OAuth credentials found (Keychain or ~/.claude/.credentials.json)'],
    });
  }
  return fetchClaudeUsage({
    accessToken: token,
    accountId,
    account,
    nowUtc: now,
    fetchFn: options.fetchFn,
  });
}

/**
 * Codex quota comes from the newest rate_limits event already present in
 * the local rollout files — no network and no credentials involved. The
 * reading is a point-in-time observation, so staleness is reported.
 */
export function readCodexQuota(options: {
  readonly sessionsRoot?: string;
  readonly nowUtc?: number;
}): QuotaSnapshot {
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const root = options.sessionsRoot ?? join(homedir(), '.codex', 'sessions');
  let newest: { observedAtUtc: number; plan: string | null; windows: QuotaWindow[] } | null = null;
  const warnings: string[] = [];
  try {
    const files = collectRolloutFiles(root)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, CODEX_RECENT_FILES);
    for (const file of files) {
      const reading = latestRateLimits(file.path);
      if (reading !== null && (newest === null || reading.observedAtUtc > newest.observedAtUtc)) {
        newest = reading;
      }
    }
  } catch (error) {
    warnings.push(`codex sessions unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (newest === null) {
    warnings.push('no codex rate_limits events found in recent rollouts');
    return snapshot('codex', 'source_log', now, [], null, warnings);
  }
  if (now - newest.observedAtUtc > CODEX_STALE_SECONDS) {
    warnings.push(
      `codex reading is ${Math.floor((now - newest.observedAtUtc) / 60)} minutes old (from local logs, not live)`,
    );
  }
  return snapshot('codex', 'source_log', newest.observedAtUtc, newest.windows, newest.plan, warnings);
}

function collectRolloutFiles(root: string): { path: string; mtimeMs: number }[] {
  const files: { path: string; mtimeMs: number }[] = [];
  for (const relative of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!relative.endsWith('.jsonl')) {
      continue;
    }
    const path = join(root, relative);
    try {
      const stats = statSync(path);
      if (stats.isFile()) {
        files.push({ path, mtimeMs: stats.mtimeMs });
      }
    } catch {
      // deleted between listing and stat
    }
  }
  return files;
}

function latestRateLimits(
  path: string,
): { observedAtUtc: number; plan: string | null; windows: QuotaWindow[] } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!line.includes('"rate_limits"')) {
      continue;
    }
    try {
      const record = asObject(JSON.parse(line));
      const payload = record === null ? null : asObject(record.payload);
      const limits = payload === null ? null : asObject(payload.rate_limits);
      const observedAtUtc = parseIso(record?.timestamp);
      if (limits === null || observedAtUtc === null) {
        continue;
      }
      const windows: QuotaWindow[] = [];
      for (const id of ['primary', 'secondary'] as const) {
        const window = asObject(limits[id]);
        const used = window?.used_percent;
        if (typeof used === 'number' && Number.isFinite(used)) {
          const resets = window?.resets_at;
          windows.push({
            id: `${id} (${window?.window_minutes ?? '?'}m)`,
            usedPercent: used,
            resetsAtUtc: typeof resets === 'number' ? resets : parseIso(resets),
          });
        }
      }
      return { observedAtUtc, plan: asString(limits.plan_type), windows };
    } catch {
      // malformed tail line; keep looking upward
    }
  }
  return null;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function makeQuotaSnapshot(options: {
  readonly agent: string;
  readonly source: QuotaSource;
  readonly observedAtUtc: number;
  readonly windows: readonly QuotaWindow[];
  readonly plan?: string | null;
  readonly accountId?: string | null;
  readonly account?: string | null;
  readonly warnings?: readonly string[];
  readonly failure?: QuotaFailure | null;
  readonly retryAfterSeconds?: number | null;
}): QuotaSnapshot {
  const failure = options.failure ?? null;
  return {
    agent: options.agent,
    accountId: options.accountId ?? null,
    account: options.account ?? null,
    failure,
    // the invariant lives here and nowhere else: no caller sets the flag
    rateLimited: failure?.kind === 'rate_limited',
    retryAfterSeconds: options.retryAfterSeconds ?? null,
    plan: options.plan ?? null,
    source: options.source,
    observedAtUtc: options.observedAtUtc,
    windows: options.windows,
    warnings: options.warnings ?? [],
  };
}

function snapshot(
  agent: string,
  source: QuotaSnapshot['source'],
  observedAtUtc: number,
  windows: readonly QuotaWindow[],
  plan: string | null,
  warnings: readonly string[],
): QuotaSnapshot {
  return makeQuotaSnapshot({ agent, source, observedAtUtc, windows, plan, warnings });
}
