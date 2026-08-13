/**
 * Antigravity (Gemini) quota. Reads the token/cache store maintained by
 * the MIT `antigravity-usage` CLI and calls the daily Cloud Code
 * endpoint the Antigravity IDE itself uses. An expiring access token is
 * refreshed with Google's public desktop-client OAuth flow, but the
 * rotated token lives IN MEMORY ONLY for this one reading — the
 * third-party store is never written (Google installed-app refresh
 * grants do not rotate the refresh token in normal operation, so the
 * store keeps working; if a rotated refresh token ever comes back we
 * surface a warning instead of persisting it). `allowRefresh: false`
 * restores the pure read-only behavior. On refresh failure the reading
 * degrades to the CLI's cached snapshot, never to fabricated data.
 *
 * Endpoint choice follows the verified path from local_docs/init/14:
 * the regular cloudcode-pa endpoint reports a different quota window
 * than actual Antigravity usage and must not be used as a fallback.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asObject, asString } from '../parsers/shared.ts';
import { makeQuotaSnapshot } from './providers.ts';
import type { FetchLike, QuotaSnapshot, QuotaWindow } from './providers.ts';

const DAILY_CLOUDCODE_BASE = 'https://daily-cloudcode-pa.googleapis.com';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Public OAuth desktop-client credentials used by the antigravity-usage
// CLI (not user secrets); env vars override them if Google rotates the app.
const DEFAULT_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const DEFAULT_OAUTH_CLIENT_SECRET = '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';
const PREFERRED_MODEL = 'Gemini 3.1 Pro (High)';
const FETCH_TIMEOUT_MS = 5000;
const REFRESH_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const CACHE_STALE_SECONDS = 60 * 60;

export const ANTIGRAVITY_AGENT = 'antigravity';

export function defaultAntigravityStoreDir(home: string = homedir()): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'antigravity-usage');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.startsWith('/') ? xdg : join(home, '.config');
  return join(base, 'antigravity-usage');
}

interface AntigravityAccount {
  readonly email: string;
  readonly dir: string;
}

interface AntigravityTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAtMs: number | null;
  readonly projectId: string | null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Ms-or-seconds tolerant epoch reader (stores have used both). */
function asEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function listAntigravityAccounts(storeDir: string): AntigravityAccount[] {
  const accountsDir = join(storeDir, 'accounts');
  let entries: string[];
  try {
    entries = readdirSync(accountsDir);
  } catch {
    return [];
  }
  const accounts: AntigravityAccount[] = [];
  for (const entry of entries) {
    const dir = join(accountsDir, entry);
    try {
      if (statSync(dir).isDirectory()) {
        accounts.push({ email: entry, dir });
      }
    } catch {
      // removed between listing and stat
    }
  }
  return accounts;
}

function lastUsedMs(account: AntigravityAccount): number {
  const metadata = readJson(join(account.dir, 'metadata.json'));
  const fromMetadata = metadata === null ? null : asEpochMs(metadata.lastUsed);
  if (fromMetadata !== null) {
    return fromMetadata;
  }
  try {
    return statSync(join(account.dir, 'tokens.json')).mtimeMs;
  } catch {
    return 0;
  }
}

/** config.json activeAccount wins; otherwise the most recently used account. */
export function resolveActiveAccount(storeDir: string): AntigravityAccount | null {
  const accounts = listAntigravityAccounts(storeDir);
  if (accounts.length === 0) {
    return null;
  }
  const config = readJson(join(storeDir, 'config.json'));
  const active = config === null ? null : asString(config.activeAccount);
  if (active !== null) {
    const match = accounts.find((account) => account.email === active);
    if (match !== undefined) {
      return match;
    }
  }
  return accounts.reduce((best, account) => (lastUsedMs(account) > lastUsedMs(best) ? account : best));
}

function readTokens(account: AntigravityAccount): AntigravityTokens | null {
  const tokens = readJson(join(account.dir, 'tokens.json'));
  const accessToken = tokens === null ? null : asString(tokens.accessToken);
  if (tokens === null || accessToken === null) {
    return null;
  }
  return {
    accessToken,
    refreshToken: asString(tokens.refreshToken),
    expiresAtMs: asEpochMs(tokens.expiresAt),
    projectId: asString(tokens.projectId),
  };
}

interface RefreshResult {
  readonly tokens: AntigravityTokens;
  readonly warnings: readonly string[];
}

/**
 * Refreshed tokens are not written back to the store, so without this
 * a long-lived process (the TUI on a 30s auto-refresh) would ask Google
 * for a new token on every single tick. Keyed by account directory and
 * dropped as soon as it expires.
 */
const refreshedTokens = new Map<string, AntigravityTokens>();

function cachedToken(dir: string, nowUtc: number): AntigravityTokens | null {
  const cached = refreshedTokens.get(dir);
  if (cached === undefined) {
    return null;
  }
  if (cached.expiresAtMs === null || cached.expiresAtMs - TOKEN_EXPIRY_BUFFER_MS <= nowUtc * 1000) {
    refreshedTokens.delete(dir);
    return null;
  }
  return cached;
}

/**
 * Google installed-app refresh grant. The result is used in memory for
 * this reading only — the antigravity-usage store stays untouched.
 */
async function refreshAccessToken(
  fetchFn: FetchLike,
  tokens: AntigravityTokens,
  nowUtc: number,
): Promise<RefreshResult> {
  if (tokens.refreshToken === null) {
    throw new Error('no refresh token in the antigravity-usage store');
  }
  const body = new URLSearchParams({
    client_id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID,
    client_secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET ?? DEFAULT_OAUTH_CLIENT_SECRET,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetchFn(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`oauth refresh http ${response.status}`);
  }
  const data = asObject(await response.json());
  const accessToken = data === null ? null : asString(data.access_token);
  const expiresIn = data?.expires_in;
  if (accessToken === null || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    throw new Error('oauth refresh returned an invalid body');
  }
  const warnings: string[] = [];
  if (data !== null && asString(data.refresh_token) !== null) {
    // rotation is abnormal for this grant; we cannot persist it, so tell the user
    warnings.push(
      'google rotated the antigravity refresh token — run "antigravity-usage login" soon or the stored token may stop working',
    );
  }
  return {
    tokens: {
      ...tokens,
      accessToken,
      expiresAtMs: (nowUtc + expiresIn) * 1000,
    },
    warnings,
  };
}

interface ModelReading {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAtUtc: number | null;
  readonly isAutocompleteOnly: boolean;
}

function usedPercentFromRemaining(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return (1 - value) * 100;
}

function parseResetEpoch(value: unknown): number | null {
  const ms = asEpochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

/** Accepts both the live API shape (quotaInfo.remainingFraction) and the CLI cache shape. */
function parseModelEntry(value: unknown): ModelReading | null {
  const model = asObject(value);
  if (model === null) {
    return null;
  }
  const label = asString(model.label) ?? asString(model.displayName) ?? asString(model.name);
  if (label === null) {
    return null;
  }
  const quotaInfo = asObject(model.quotaInfo);
  const remaining = quotaInfo !== null ? quotaInfo.remainingFraction : model.remainingPercentage;
  const usedPercent = usedPercentFromRemaining(remaining);
  if (usedPercent === null) {
    return null;
  }
  return {
    label,
    usedPercent,
    resetsAtUtc: parseResetEpoch(quotaInfo !== null ? quotaInfo.resetTime : model.resetTime),
    isAutocompleteOnly: model.isAutocompleteOnly === true,
  };
}

function toWindow(reading: ModelReading): QuotaWindow {
  return { id: reading.label, usedPercent: reading.usedPercent, resetsAtUtc: reading.resetsAtUtc };
}

function pickModelWindow(models: readonly ModelReading[]): QuotaWindow | null {
  const candidates = models.filter((model) => !model.isAutocompleteOnly);
  const chosen = candidates.find((model) => model.label === PREFERRED_MODEL) ?? candidates[0];
  return chosen === undefined ? null : toWindow(chosen);
}

function parseCreditsWindow(value: unknown): QuotaWindow | null {
  const credits = asObject(value);
  if (credits === null) {
    return null;
  }
  const used = credits.usedPercentage;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1) {
    return null;
  }
  return { id: 'prompt credits', usedPercent: used * 100, resetsAtUtc: null };
}

function parseModelList(value: unknown): ModelReading[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const readings: ModelReading[] = [];
  for (const entry of value) {
    const reading = parseModelEntry(entry);
    if (reading !== null) {
      readings.push(reading);
    }
  }
  return readings;
}

interface CacheReading {
  readonly observedAtUtc: number;
  readonly windows: readonly QuotaWindow[];
}

function readCacheSnapshot(account: AntigravityAccount): CacheReading | null {
  const cache = readJson(join(account.dir, 'cache.json'));
  const data = cache === null ? null : asObject(cache.data);
  if (cache === null || data === null) {
    return null;
  }
  const observedAtMs = asEpochMs(cache.cachedAt) ?? asEpochMs(data.timestamp);
  if (observedAtMs === null) {
    return null;
  }
  const windows: QuotaWindow[] = [];
  const modelWindow = pickModelWindow(parseModelList(data.models));
  if (modelWindow !== null) {
    windows.push(modelWindow);
  }
  const creditsWindow = parseCreditsWindow(data.promptCredits);
  if (creditsWindow !== null) {
    windows.push(creditsWindow);
  }
  return { observedAtUtc: Math.floor(observedAtMs / 1000), windows };
}

async function postCloudCode(
  fetchFn: FetchLike,
  baseUrl: string,
  path: string,
  accessToken: string,
  body: unknown,
): Promise<Record<string, unknown> | null> {
  const response = await fetchFn(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`http ${response.status}`);
  }
  return asObject(await response.json());
}

/**
 * Live response shape (verified against the real endpoint 2026-08-11):
 * `models` is a map of modelId -> { displayName, quotaInfo:
 * { remainingFraction, resetTime }, ... } plus a top-level
 * `defaultAgentModelId`. Selection: preferred display name, then the
 * default agent model, then the first quota-bearing entry.
 */
function pickLiveWindow(body: Record<string, unknown> | null): QuotaWindow | null {
  const modelsMap = body === null ? null : asObject(body.models);
  if (modelsMap === null) {
    return null;
  }
  const readings = new Map<string, ModelReading>();
  for (const [id, entry] of Object.entries(modelsMap)) {
    const reading = parseModelEntry(entry);
    if (reading !== null) {
      readings.set(id, reading);
    }
  }
  if (readings.size === 0) {
    return null;
  }
  const all = [...readings.values()];
  const preferred = all.find((reading) => reading.label === PREFERRED_MODEL);
  if (preferred !== undefined) {
    return toWindow(preferred);
  }
  const defaultId = asString(body === null ? null : body.defaultAgentModelId);
  const fallback = (defaultId !== null ? readings.get(defaultId) : undefined) ?? all[0];
  return fallback === undefined ? null : toWindow(fallback);
}

async function fetchLiveWindows(
  fetchFn: FetchLike,
  baseUrl: string,
  tokens: AntigravityTokens,
): Promise<QuotaWindow[]> {
  const loaded = await postCloudCode(fetchFn, baseUrl, '/v1internal:loadCodeAssist', tokens.accessToken, {
    metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  });
  const project =
    (loaded === null ? null : asString(loaded.cloudaicompanionProject)) ?? tokens.projectId;
  if (project === null) {
    throw new Error('no project id available (loadCodeAssist and tokens.json)');
  }
  const models = await postCloudCode(fetchFn, baseUrl, '/v1internal:fetchAvailableModels', tokens.accessToken, {
    project,
  });
  const window = pickLiveWindow(models);
  if (window === null) {
    throw new Error('no quota-bearing models in response');
  }
  return [window];
}

export async function readAntigravityQuota(options: {
  readonly storeDir?: string;
  readonly nowUtc?: number;
  readonly fetchFn?: FetchLike;
  readonly baseUrl?: string;
  /** false = never call the OAuth token endpoint (pure read-only mode). */
  readonly allowRefresh?: boolean;
  /** Read this specific account instead of the active one. */
  readonly accountEmail?: string;
}): Promise<QuotaSnapshot> {
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const storeDir = options.storeDir ?? defaultAntigravityStoreDir();
  const account =
    options.accountEmail === undefined
      ? resolveActiveAccount(storeDir)
      : (listAntigravityAccounts(storeDir).find(
          (candidate) => candidate.email === options.accountEmail,
        ) ?? null);
  if (account === null) {
    if (options.accountEmail !== undefined) {
      return makeQuotaSnapshot({
        agent: ANTIGRAVITY_AGENT,
        accountId: options.accountEmail,
        account: options.accountEmail,
        source: 'third_party_cache',
        observedAtUtc: now,
        windows: [],
        warnings: [`antigravity account ${options.accountEmail} not found in the store`],
      });
    }
    return makeQuotaSnapshot({
      agent: ANTIGRAVITY_AGENT,
      source: 'third_party_cache',
      observedAtUtc: now,
      windows: [],
      warnings: [
        `no antigravity-usage store found (${storeDir}) — install the antigravity-usage CLI and run "antigravity-usage login"`,
      ],
    });
  }

  const warnings: string[] = [];
  const fetchFn = options.fetchFn ?? fetch;
  const stored = readTokens(account);
  const isValid = (tokens: AntigravityTokens | null): tokens is AntigravityTokens =>
    tokens !== null &&
    tokens.expiresAtMs !== null &&
    tokens.expiresAtMs - TOKEN_EXPIRY_BUFFER_MS > now * 1000;

  let tokens: AntigravityTokens | null = isValid(stored) ? stored : cachedToken(account.dir, now);
  if (tokens === null && stored !== null && (options.allowRefresh ?? true)) {
    try {
      const refreshed = await refreshAccessToken(fetchFn, stored, now);
      tokens = refreshed.tokens;
      refreshedTokens.set(account.dir, refreshed.tokens);
      warnings.push(...refreshed.warnings);
    } catch (error) {
      warnings.push(
        `antigravity token refresh failed: ${error instanceof Error ? error.message : String(error)} — run "antigravity-usage login"`,
      );
    }
  } else if (tokens === null && stored !== null) {
    warnings.push(
      'antigravity access token expired (refresh disabled) — run "antigravity-usage refresh" for live data',
    );
  }

  if (tokens !== null) {
    try {
      const windows = await fetchLiveWindows(
        fetchFn,
        options.baseUrl ?? DAILY_CLOUDCODE_BASE,
        tokens,
      );
      return makeQuotaSnapshot({
        agent: ANTIGRAVITY_AGENT,
        accountId: account.email,
        account: account.email,
        source: 'vendor_api',
        observedAtUtc: now,
        windows,
        warnings,
      });
    } catch (error) {
      warnings.push(
        `antigravity live quota fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const cached = readCacheSnapshot(account);
  if (cached === null || cached.windows.length === 0) {
    return makeQuotaSnapshot({
      agent: ANTIGRAVITY_AGENT,
      accountId: account.email,
      account: account.email,
      source: 'third_party_cache',
      observedAtUtc: now,
      windows: [],
      warnings: [...warnings, 'no cached antigravity quota snapshot available'],
    });
  }
  if (now - cached.observedAtUtc > CACHE_STALE_SECONDS) {
    // The cache is the antigravity-usage CLI's frozen state from the
    // last time THAT tool ran — possibly weeks ago. Serving it as the
    // current reading resurrects ancient percentages (a 42-day-old
    // "99% used" fired critical alerts on every transient timeout).
    // Return no windows instead so the caller's own stored last-good
    // — usually minutes old — stands in.
    const hours = Math.floor((now - cached.observedAtUtc) / 3600);
    return makeQuotaSnapshot({
      agent: ANTIGRAVITY_AGENT,
      accountId: account.email,
      account: account.email,
      source: 'third_party_cache',
      observedAtUtc: now,
      windows: [],
      warnings: [...warnings, `cached antigravity reading is ${hours}h old — ignored`],
    });
  }
  return makeQuotaSnapshot({
    agent: ANTIGRAVITY_AGENT,
    accountId: account.email,
    account: account.email,
    source: 'third_party_cache',
    observedAtUtc: cached.observedAtUtc,
    windows: cached.windows,
    warnings,
  });
}
