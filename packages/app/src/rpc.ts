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

    let request: { id?: number | string | null; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(trimmed);
    } catch {
      return respond(null, undefined, { code: PARSE_ERROR, message: 'invalid JSON' });
    }

    const id = request.id ?? null;
    const isNotification = !('id' in request);
    if (typeof request.method !== 'string' || request.method === '') {
      return isNotification ? null : respond(id, undefined, { code: INVALID_REQUEST, message: 'method must be a string' });
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
