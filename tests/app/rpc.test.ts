import { describe, expect, test } from 'bun:test';

import { HANDLER_ERROR, METHOD_NOT_FOUND, PARSE_ERROR, RpcServer } from '@llmtally/app/rpc.ts';

function parse(line: string | null): any {
  expect(line).not.toBeNull();
  return JSON.parse(line as string);
}

describe('RpcServer', () => {
  test('dispatches a request and returns the handler result', async () => {
    // Arrange
    const server = new RpcServer();
    server.register('ping', (params) => ({ echo: params }));

    // Act
    const reply = parse(await server.handleLine('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"a":1}}'));

    // Assert
    expect(reply).toEqual({ jsonrpc: '2.0', id: 1, result: { echo: { a: 1 } } });
  });

  test('returns a parse error for invalid JSON', async () => {
    const server = new RpcServer();

    const reply = parse(await server.handleLine('{nope'));

    expect(reply.error.code).toBe(PARSE_ERROR);
    expect(reply.id).toBeNull();
  });

  test('returns method-not-found for unregistered methods', async () => {
    const server = new RpcServer();

    const reply = parse(await server.handleLine('{"jsonrpc":"2.0","id":"x","method":"missing"}'));

    expect(reply.error.code).toBe(METHOD_NOT_FOUND);
    expect(reply.id).toBe('x');
  });

  test('maps a thrown handler error to a response, not a crash', async () => {
    const server = new RpcServer();
    server.register('boom', () => {
      throw new Error('switch failed: lock busy');
    });

    const reply = parse(await server.handleLine('{"jsonrpc":"2.0","id":2,"method":"boom"}'));

    expect(reply.error.code).toBe(HANDLER_ERROR);
    expect(reply.error.message).toContain('lock busy');
  });

  test('notifications produce no response, even on error', async () => {
    const server = new RpcServer();
    server.register('boom', () => {
      throw new Error('nope');
    });

    expect(await server.handleLine('{"jsonrpc":"2.0","method":"boom"}')).toBeNull();
    expect(await server.handleLine('')).toBeNull();
  });

  test('awaits async handlers', async () => {
    const server = new RpcServer();
    server.register('later', async () => 'done');

    const reply = parse(await server.handleLine('{"jsonrpc":"2.0","id":3,"method":"later"}'));

    expect(reply.result).toBe('done');
  });
});
