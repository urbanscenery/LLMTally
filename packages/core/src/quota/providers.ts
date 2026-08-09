import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readClaudeActiveIdentity } from '../accounts/claude.ts';
import { asObject, asString } from '../parsers/shared.ts';

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

export interface QuotaSnapshot {
  readonly agent: string;
  /** The vendor answered 429; the reading failed for that reason alone. */
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
export function defaultClaudeTokenReader(home: string = homedir()): TokenReader {
  return () => {
    try {
      const keychain = Bun.spawnSync(
        ['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { stdout: 'pipe', stderr: 'pipe' },
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
  readonly account: string | null;
  readonly nowUtc: number;
  readonly fetchFn?: FetchLike;
}

/**
 * One read of the OAuth usage endpoint with a caller-supplied token, so
 * the same code serves the logged-in account and every stored one.
 */
export async function fetchClaudeUsage(request: ClaudeUsageRequest): Promise<QuotaSnapshot> {
  const { accessToken, account, nowUtc } = request;
  try {
    const fetchFn = request.fetchFn ?? fetch;
    const response = await fetchFn(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      return makeQuotaSnapshot({
        agent: 'claude-code',
        source: 'vendor_api',
        observedAtUtc: nowUtc,
        windows: [],
        account,
        rateLimited: true,
        retryAfterSeconds: Number.isFinite(header) && header > 0 ? header : null,
        warnings: ['claude usage endpoint returned 429 (rate limited)'],
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
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: nowUtc,
      windows,
      account,
    });
  } catch (error) {
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: nowUtc,
      windows: [],
      account,
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
  /** Display label for the active account; defaults to ~/.claude.json oauthAccount email. */
  readonly accountReader?: () => string | null;
}): Promise<QuotaSnapshot> {
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const readAccount =
    options.accountReader ?? ((): string | null => readClaudeActiveIdentity()?.email ?? null);
  const account = readAccount();
  const token = (options.tokenReader ?? defaultClaudeTokenReader())();
  if (token === null) {
    return makeQuotaSnapshot({
      agent: 'claude-code',
      source: 'vendor_api',
      observedAtUtc: now,
      windows: [],
      account,
      warnings: ['no Claude Code OAuth credentials found (Keychain or ~/.claude/.credentials.json)'],
    });
  }
  return fetchClaudeUsage({ accessToken: token, account, nowUtc: now, fetchFn: options.fetchFn });
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
  readonly account?: string | null;
  readonly warnings?: readonly string[];
  readonly rateLimited?: boolean;
  readonly retryAfterSeconds?: number | null;
}): QuotaSnapshot {
  return {
    agent: options.agent,
    account: options.account ?? null,
    rateLimited: options.rateLimited ?? false,
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
