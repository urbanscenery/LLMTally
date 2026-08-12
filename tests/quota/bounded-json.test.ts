import { describe, expect, test } from 'bun:test';

import { readBoundedJson } from '@llmtally/core/quota/bounded-json.ts';

const LIMIT = 1024;

describe('readBoundedJson', () => {
  test('parses a normal object response', async () => {
    // Act
    const body = await readBoundedJson(new Response(JSON.stringify({ a: 1 })), LIMIT);

    // Assert
    expect(body).toEqual({ a: 1 });
  });

  test('refuses a body whose declared length already exceeds the cap', async () => {
    // Arrange — the transfer is rejected before a single chunk is read
    const response = new Response(JSON.stringify({ a: 1 }), {
      headers: { 'content-length': String(LIMIT + 1) },
    });

    // Act & Assert
    expect(await readBoundedJson(response, LIMIT)).toBeNull();
  });

  test('stops a stream that grows past the cap instead of collecting it', async () => {
    // Arrange — a body that keeps producing chunks, and counts them
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array(256));
      },
    });

    // Act
    const body = await readBoundedJson(new Response(stream), LIMIT);

    // Assert — cancelled shortly after crossing the cap, not run forever
    expect(body).toBeNull();
    expect(produced).toBeLessThanOrEqual(8);
  });

  test('a body exactly at the cap is still read', async () => {
    // Arrange
    const padding = 'x'.repeat(LIMIT - JSON.stringify({ a: '' }).length);
    const text = JSON.stringify({ a: padding });

    // Act
    const body = await readBoundedJson(new Response(text), text.length);

    // Assert
    expect(body).toEqual({ a: padding });
  });

  test.each([
    ['malformed json', new Response('{nope')],
    ['a json array', new Response('[1,2,3]')],
    ['a json scalar', new Response('42')],
    ['an empty body', new Response(null, { status: 204 })],
  ])('%s yields null rather than a half-understood value', async (_label, response) => {
    // Act & Assert
    expect(await readBoundedJson(response, LIMIT)).toBeNull();
  });
});
