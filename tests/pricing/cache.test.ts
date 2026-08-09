import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPricingPayload } from '@llmtally/core/pricing/cache.ts';
import { makeTempDir } from '../helpers.ts';

const URL = 'https://example.test/prices.json';
const NOW = 1_786_400_000;

function countingFetch(
  responder: (url: string, init?: RequestInit) => Response,
): { fetchFn: (url: string, init?: RequestInit) => Promise<Response>; calls: () => number } {
  let calls = 0;
  return {
    fetchFn: (url, init) => {
      calls += 1;
      return Promise.resolve(responder(url, init));
    },
    calls: () => calls,
  };
}

function baseOptions(cachePath: string) {
  return { source: 'litellm' as const, url: URL, cachePath, maxBytes: 1024 * 1024 };
}

async function seedCache(cachePath: string, payload: unknown, validatedAtUtc: number) {
  const { fetchFn } = countingFetch(
    () => new Response(JSON.stringify(payload), { status: 200, headers: { etag: '"v1"' } }),
  );
  await loadPricingPayload({
    ...baseOptions(cachePath),
    allowRefresh: true,
    fetchFn,
    nowUtc: validatedAtUtc,
  });
}

describe('loadPricingPayload', () => {
  test('a fresh cache is served without any network call', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');
    await seedCache(cachePath, { m: 1 }, NOW - 100);
    const counter = countingFetch(() => new Response('unused'));

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      allowRefresh: true,
      fetchFn: counter.fetchFn,
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('fresh');
    expect(result.payload).toEqual({ m: 1 });
    expect(counter.calls()).toBe(0);
  });

  test('a stale cache revalidated with 304 keeps its payload', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');
    await seedCache(cachePath, { m: 1 }, NOW - 10_000);
    const counter = countingFetch((_, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['If-None-Match']).toBe('"v1"');
      return new Response(null, { status: 304 });
    });

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      allowRefresh: true,
      fetchFn: counter.fetchFn,
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('fresh');
    expect(result.payload).toEqual({ m: 1 });
    expect(counter.calls()).toBe(1);
  });

  test('a failed refresh falls back to the stale cache with an age warning', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');
    await seedCache(cachePath, { m: 1 }, NOW - 10_000);
    const counter = countingFetch(() => {
      throw new Error('network down');
    });

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      allowRefresh: true,
      fetchFn: (url, init) => {
        counter.calls();
        return Promise.reject(new Error('network down'));
      },
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('stale');
    expect(result.payload).toEqual({ m: 1 });
    expect(result.warnings.some((w) => w.includes('refresh failed'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('stale'))).toBe(true);
  });

  test('a cache older than 30 days produces a strong warning', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');
    await seedCache(cachePath, { m: 1 }, NOW - 40 * 86_400);

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      allowRefresh: false,
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('stale');
    expect(result.warnings.some((w) => w.includes('VERY stale'))).toBe(true);
  });

  test('no cache and a failing network yields absent without throwing', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      allowRefresh: true,
      fetchFn: () => Promise.reject(new Error('offline')),
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('absent');
    expect(result.payload).toBeNull();
  });

  test('noRefresh never touches the network even when the cache is absent', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');
    const counter = countingFetch(() => new Response('unused'));

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      allowRefresh: false,
      fetchFn: counter.fetchFn,
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('absent');
    expect(counter.calls()).toBe(0);
  });

  test('writes the cache file with 0600 permissions', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');

    // Act
    await seedCache(cachePath, { m: 1 }, NOW);

    // Assert
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  test('a tampered cache fails its integrity check and is ignored', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');
    await seedCache(cachePath, { m: 1 }, NOW - 100);
    const envelope = JSON.parse(readFileSync(cachePath, 'utf8'));
    envelope.payload = { m: 999 };
    writeFileSync(cachePath, JSON.stringify(envelope));

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      allowRefresh: false,
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('absent');
    expect(result.warnings.some((w) => w.includes('integrity'))).toBe(true);
  });

  test('rejects oversized payloads and falls back', async () => {
    // Arrange
    const cachePath = join(makeTempDir(), 'pricing-litellm.json');

    // Act
    const result = await loadPricingPayload({
      ...baseOptions(cachePath),
      maxBytes: 8,
      allowRefresh: true,
      fetchFn: () => Promise.resolve(new Response(JSON.stringify({ big: 'x'.repeat(100) }))),
      nowUtc: NOW,
    });

    // Assert
    expect(result.status).toBe('absent');
    expect(result.warnings.some((w) => w.includes('exceeds'))).toBe(true);
  });
});
