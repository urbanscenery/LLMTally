/**
 * JSON-RPC 2.0 over newline-delimited stdio — the seam between the Swift
 * menubar shell and the Bun sidecar. The shell never touches SQLite or
 * the vault; it speaks this protocol and renders what comes back.
 *
 * Framing is one JSON document per line. Requests without an id are
 * notifications and produce no response line.
 */

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface RpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: RpcError;
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const HANDLER_ERROR = -32000;

export type RpcHandler = (params: unknown) => unknown;

export class RpcServer {
  readonly #handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    this.#handlers.set(method, handler);
  }

  /** Handles one request line; returns the response line or null for notifications. */
  async handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed === '') {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return respond(null, undefined, { code: PARSE_ERROR, message: 'invalid JSON' });
    }
    // a primitive (`null`, `1`, `"x"`) is a parseable line but not a
    // request — reading `.id` off it crashed the helper (audit CX-45)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return respond(null, undefined, { code: INVALID_REQUEST, message: 'request must be an object' });
    }
    const request = parsed as { id?: unknown; jsonrpc?: unknown; method?: unknown; params?: unknown };

    const isNotification = !('id' in request);
    const rawId = request.id ?? null;
    if (rawId !== null && typeof rawId !== 'number' && typeof rawId !== 'string') {
      return respond(null, undefined, { code: INVALID_REQUEST, message: 'id must be a number, string, or null' });
    }
    const id = rawId;
    // an INVALID request is answered even without an id (id null per
    // spec): treating `{}` as a silent notification left the caller
    // waiting out its full deadline (audit codex C1-08). Only a request
    // that is otherwise valid and merely lacks an id is a notification.
    if (request.jsonrpc !== '2.0') {
      return respond(id, undefined, { code: INVALID_REQUEST, message: 'jsonrpc must be "2.0"' });
    }
    if (typeof request.method !== 'string' || request.method === '') {
      return respond(id, undefined, { code: INVALID_REQUEST, message: 'method must be a string' });
    }
    if (
      request.params !== undefined &&
      (request.params === null || typeof request.params !== 'object')
    ) {
      return respond(id, undefined, { code: INVALID_REQUEST, message: 'params must be an object or array' });
    }

    const handler = this.#handlers.get(request.method);
    if (handler === undefined) {
      return isNotification ? null : respond(id, undefined, { code: METHOD_NOT_FOUND, message: `unknown method: ${request.method}` });
    }

    try {
      const result = await handler(request.params);
      return isNotification ? null : respond(id, result ?? null, undefined);
    } catch (error: unknown) {
      if (isNotification) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const data = error instanceof Error ? { name: error.name } : undefined;
      return respond(id, undefined, { code: HANDLER_ERROR, message, data });
    }
  }
}

function respond(id: number | string | null, result: unknown, error: RpcError | undefined): string {
  const body: RpcResponse = error === undefined
    ? { jsonrpc: '2.0', id, result }
    : { jsonrpc: '2.0', id, error };
  return JSON.stringify(body);
}
