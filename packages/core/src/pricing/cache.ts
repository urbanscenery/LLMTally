import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { asObject } from '../parsers/shared.ts';
import type {
  PricingCacheEnvelope,
  PricingCacheStatus,
  RemotePriceSource,
} from './types.ts';

const CACHE_TTL_SECONDS = 3600;
const STRONG_STALE_SECONDS = 30 * 24 * 3600;
// generous enough for a cold multi-MB download on a slow link, while a
// failure still degrades to stale/absent instead of blocking the report
const FETCH_TIMEOUT_MS = 5000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SECONDS_PER_DAY = 86_400;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CacheSourceOptions {
  readonly source: RemotePriceSource;
  readonly url: string;
  readonly cachePath: string;
  readonly maxBytes: number;
  readonly allowRefresh: boolean;
  readonly fetchFn?: FetchLike;
  readonly nowUtc?: number;
  readonly ttlSeconds?: number;
  /** Rejects a 200 payload BEFORE it replaces a known-good stale cache. */
  readonly validatePayload?: (payload: unknown) => boolean;
}

export interface CacheSourceResult {
  readonly status: PricingCacheStatus;
  readonly payload: unknown | null;
  readonly fetchedAtUtc: number | null;
  readonly warnings: readonly string[];
}

export function defaultCachePath(source: RemotePriceSource): string {
  return join(homedir(), '.llmtally', 'cache', `pricing-${source}.json`);
}

/**
 * Network must never fail a report: any refresh problem falls back to the
 * stale cache (with an age warning, unbounded) or an absent result. Only
 * the recoverable cache/fetch surface is swallowed — programmer errors
 * still propagate.
 */
export async function loadPricingPayload(options: CacheSourceOptions): Promise<CacheSourceResult> {
  const now = options.nowUtc ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? CACHE_TTL_SECONDS;
  const warnings: string[] = [];
  const envelope = readEnvelope(options.cachePath, options.source, warnings);

  if (envelope !== null && now - envelope.validatedAtUtc <= ttl) {
    return { status: 'fresh', payload: envelope.payload, fetchedAtUtc: envelope.fetchedAtUtc, warnings };
  }
  if (!options.allowRefresh) {
    return staleOrAbsent(envelope, now, warnings);
  }

  const fetchFn = options.fetchFn ?? fetch;
  try {
    const headers: Record<string, string> = { 'User-Agent': 'llmtally' };
    if (envelope?.etag) {
      headers['If-None-Match'] = envelope.etag;
    }
    const response = await fetchFn(options.url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 304 && envelope !== null) {
      const revalidated: PricingCacheEnvelope = { ...envelope, validatedAtUtc: now };
      writeEnvelopeAtomically(options.cachePath, revalidated);
      return { status: 'fresh', payload: envelope.payload, fetchedAtUtc: envelope.fetchedAtUtc, warnings };
    }
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > options.maxBytes) {
      throw new Error(`payload exceeds ${options.maxBytes} bytes`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > options.maxBytes) {
      throw new Error(`payload exceeds ${options.maxBytes} bytes`);
    }
    const payload: unknown = JSON.parse(text);
    if (options.validatePayload !== undefined && !options.validatePayload(payload)) {
      throw new Error('payload failed source validation');
    }
    const fresh: PricingCacheEnvelope = {
      version: 1,
      source: options.source,
      url: options.url,
      fetchedAtUtc: now,
      validatedAtUtc: now,
      etag: response.headers.get('etag'),
      payloadSha256: payloadHash(payload),
      payload,
    };
    try {
      writeEnvelopeAtomically(options.cachePath, fresh);
    } catch (error) {
      // a persistence problem must not throw away a validated download
      warnings.push(
        `cannot persist ${options.source} price cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { status: 'fresh', payload, fetchedAtUtc: now, warnings };
  } catch (error) {
    warnings.push(
      `pricing refresh failed for ${options.source}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return staleOrAbsent(envelope, now, warnings);
  }
}

function staleOrAbsent(
  envelope: PricingCacheEnvelope | null,
  now: number,
  warnings: string[],
): CacheSourceResult {
  if (envelope === null) {
    return { status: 'absent', payload: null, fetchedAtUtc: null, warnings };
  }
  const ageSeconds = now - envelope.validatedAtUtc;
  const ageDays = Math.floor(ageSeconds / SECONDS_PER_DAY);
  if (ageSeconds > STRONG_STALE_SECONDS) {
    warnings.push(
      `${envelope.source} prices are VERY stale (${ageDays} days old); costs may be wrong`,
    );
  } else {
    warnings.push(`using stale ${envelope.source} prices (last validated ${ageDays}d ago)`);
  }
  return { status: 'stale', payload: envelope.payload, fetchedAtUtc: envelope.fetchedAtUtc, warnings };
}

function readEnvelope(
  path: string,
  source: RemotePriceSource,
  warnings: string[],
): PricingCacheEnvelope | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(
        `cache for ${source} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`cache for ${source} is not valid JSON; ignoring it`);
    return null;
  }
  const record = asObject(parsed);
  if (
    record === null ||
    record.version !== 1 ||
    record.source !== source ||
    typeof record.url !== 'string' ||
    typeof record.fetchedAtUtc !== 'number' ||
    typeof record.validatedAtUtc !== 'number' ||
    typeof record.payloadSha256 !== 'string' ||
    !('payload' in record)
  ) {
    warnings.push(`cache for ${source} has an invalid envelope; ignoring it`);
    return null;
  }
  if (payloadHash(record.payload) !== record.payloadSha256) {
    warnings.push(`cache for ${source} failed its integrity check; ignoring it`);
    return null;
  }
  return {
    version: 1,
    source,
    url: record.url,
    fetchedAtUtc: record.fetchedAtUtc,
    validatedAtUtc: record.validatedAtUtc,
    etag: typeof record.etag === 'string' ? record.etag : null,
    payloadSha256: record.payloadSha256,
    payload: record.payload,
  };
}

function writeEnvelopeAtomically(path: string, envelope: PricingCacheEnvelope): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(dirname(path), DIRECTORY_MODE);
  const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let renamed = false;
  try {
    const fd = openSync(tempPath, 'wx', FILE_MODE);
    try {
      writeSync(fd, JSON.stringify(envelope));
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, path);
    renamed = true;
    chmodSync(path, FILE_MODE);
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tempPath);
      } catch {
        // the temp file was never created or is already gone
      }
    }
  }
}

function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
