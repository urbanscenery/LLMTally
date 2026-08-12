/**
 * Reading a JSON response without agreeing to hold whatever the other
 * side decides to send.
 *
 * `response.text()` buffers the entire body before any length can be
 * checked, so a size test after it is a parse guard, not a memory one.
 * Here the limit is enforced while the body arrives: the declared
 * length is rejected up front when it is already too large, and the
 * stream is cancelled the moment the received bytes cross the cap.
 *
 * Every failure — oversized, truncated, unreadable, not an object —
 * comes back as `null`. Callers turn that into "the response format
 * changed", never into a zero reading.
 */
import { asObject } from '../parsers/shared.ts';

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const body = response.body;
  if (body === null) {
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        // stop the transfer rather than finish collecting something we
        // have already decided not to parse
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return asObject(JSON.parse(new TextDecoder().decode(merged)));
  } catch {
    return null;
  }
}

/**
 * `Retry-After` in either form the HTTP spec allows: delta-seconds, or
 * an absolute date. Ignoring the date form is not neutral — it drops
 * the vendor's instruction entirely and falls back to a wait we chose,
 * which can be shorter than what was asked for.
 *
 * Returns null when the header is absent, unparseable, or already in
 * the past; the caller's own backoff then applies.
 */
export function parseRetryAfterSeconds(response: Response, nowUtc: number): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.floor(seconds) : null;
  }
  const at = Date.parse(header);
  if (Number.isNaN(at)) {
    return null;
  }
  const wait = Math.floor(at / 1000) - nowUtc;
  return wait > 0 ? wait : null;
}
