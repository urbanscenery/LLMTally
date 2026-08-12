/**
 * Sidecar entry: `bun packages/app/src/sidecar-main.ts [--db <path>]`.
 * Reads newline-delimited JSON-RPC requests on stdin, writes responses
 * on stdout, exits when stdin closes (the Swift shell owns the process
 * lifetime). Anything diagnostic goes to stderr so stdout stays a pure
 * protocol channel.
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

import { defaultDatabasePath } from '@llmtally/core/config/paths.ts';

import { registerSidecarMethods } from './api.ts';
import { RpcServer } from './rpc.ts';
import type { SidecarOptions } from './api.ts';

export function createSidecarServer(options: SidecarOptions): RpcServer {
  const server = new RpcServer();
  registerSidecarMethods(server, options);
  return server;
}

export async function runSidecar(argv: readonly string[]): Promise<number> {
  let databasePath = defaultDatabasePath();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--db') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write('usage: sidecar-main.ts [--db <path>]\n');
        return 2;
      }
      databasePath = resolve(value);
      index += 1;
    } else {
      process.stderr.write(`unknown argument: ${argv[index]}\n`);
      return 2;
    }
  }

  const server = createSidecarServer({ databasePath });
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    const reply = await server.handleLine(line);
    if (reply !== null) {
      process.stdout.write(`${reply}\n`);
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runSidecar(process.argv.slice(2));
}
