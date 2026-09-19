import { readFileSync } from 'node:fs';

import type {
  KeychainProcessRequest,
  KeychainProcessRunner,
} from '../packages/core/src/accounts/keychain-native.ts';
import type { KeychainPort } from '../packages/core/src/accounts/keychain.ts';
import type { SwitchPorts } from '../packages/core/src/accounts/switch.ts';

export type CreateMacosKeychain = (options: {
  readonly helperPath: string;
  readonly keychainPath: string;
  readonly runner?: KeychainProcessRunner;
}) => KeychainPort;

export type WithKeychainInteraction = <T>(operation: () => T) => T;

export interface SwitchQaOptions {
  readonly createMacosKeychain: CreateMacosKeychain;
  readonly withKeychainInteraction: WithKeychainInteraction;
  readonly helperPath: string;
  readonly sourceRoot: string;
  readonly artifact: 'source' | 'package' | 'app';
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export function execute(
  argv: readonly string[],
  input?: string,
  timeout = 30_000,
): ProcessResult {
  const result = Bun.spawnSync([...argv], {
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

export function requireSuccess(label: string, result: ProcessResult): string {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${result.exitCode}`);
  }
  return result.stdout.trim();
}

export function stateFingerprint(): string {
  const state = [
    requireSuccess('list-keychains', execute(['/usr/bin/security', 'list-keychains', '-d', 'user'])),
    requireSuccess('default-keychain', execute(['/usr/bin/security', 'default-keychain', '-d', 'user'])),
    requireSuccess('login-keychain', execute(['/usr/bin/security', 'login-keychain'])),
  ].join('\0');
  return new Bun.CryptoHasher('sha256').update(state).digest('hex');
}

export function credential(
  totalLength: number,
  account: string,
  mcp: Readonly<Record<string, unknown>>,
): string {
  const base = {
    claudeAiOauth: { accessToken: `access-${account}`, refreshToken: `refresh-${account}` },
    mcpOAuth: mcp,
    padding: '',
  };
  const paddingLength = totalLength - JSON.stringify(base).length;
  if (paddingLength < 0) {
    throw new Error(`credential fixture exceeds requested length ${totalLength}`);
  }
  const value = JSON.stringify({ ...base, padding: 'x'.repeat(paddingLength) });
  if (value.length !== totalLength) {
    throw new Error(`credential fixture length mismatch for ${totalLength}`);
  }
  return value;
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

export function parseRecord(text: string): Readonly<Record<string, unknown>> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function activeAccount(configPath: string): string | null {
  const root = asRecord(JSON.parse(readFileSync(configPath, 'utf8')));
  const oauth = root === null ? null : asRecord(root.oauthAccount);
  return oauth !== null && typeof oauth.accountUuid === 'string' ? oauth.accountUuid : null;
}

export function assertState(
  label: string,
  ports: SwitchPorts,
  configPath: string,
  expectedAccount: string,
  expectedLength: number,
  expectedMcp: Readonly<Record<string, unknown>>,
): void {
  const text = ports.activeStore.read();
  const parsed = text === null ? null : asRecord(JSON.parse(text));
  const mcp = parsed === null ? null : asRecord(parsed.mcpOAuth);
  const actualConfigAccount = activeAccount(configPath);
  const actualMarker = ports.vault.activeAccountId('claude-code');
  const mcpMatches = JSON.stringify(mcp) === JSON.stringify(expectedMcp);
  if (text?.length !== expectedLength || !mcpMatches || actualConfigAccount !== expectedAccount || actualMarker !== expectedAccount) {
    throw new Error(
      `${label} state verification failed (length ${text?.length ?? 0}/${expectedLength}, MCP ${mcpMatches}, config ${actualConfigAccount === expectedAccount}, marker ${actualMarker === expectedAccount})`,
    );
  }
}

export function serviceFromRequest(request: KeychainProcessRequest): string | null {
  if (request.stdin === undefined) {
    return null;
  }
  const parsed = asRecord(JSON.parse(request.stdin));
  return parsed !== null && typeof parsed.service === 'string' ? parsed.service : null;
}

export async function expectFailure(
  label: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

export function rpcResultAccount(response: string | null): string | null {
  const root = response === null ? null : asRecord(JSON.parse(response));
  const result = root === null ? null : asRecord(root.result);
  const target = result === null ? null : asRecord(result.target);
  return target !== null && typeof target.accountId === 'string' ? target.accountId : null;
}
