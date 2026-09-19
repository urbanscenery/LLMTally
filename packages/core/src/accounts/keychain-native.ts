import { dirname, join, resolve } from 'node:path';

const PROTOCOL_VERSION = 1;
const TIMEOUT_MS = 5000;

export interface KeychainProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
}

export interface KeychainProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr?: string;
}

export type KeychainProcessRunner = (request: KeychainProcessRequest) => KeychainProcessResult;

export interface NativeWriteRequest {
  readonly service: string;
  readonly account: string;
  readonly secret: string;
}

export type NativeWriteResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'failure'; readonly message: string; readonly requiresInteraction?: boolean };

export const defaultKeychainProcessRunner: KeychainProcessRunner = (request) => {
  const processResult = Bun.spawnSync([request.executable, ...request.args], {
    stdin: request.stdin === undefined ? 'ignore' : new TextEncoder().encode(request.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: request.timeoutMs,
  });
  return {
    exitCode: processResult.exitCode,
    stdout: processResult.stdout.toString(),
    stderr: processResult.stderr.toString(),
  };
};

export function resolveKeychainHelperPath(): string {
  if (import.meta.dir.startsWith('/$bunfs/')) {
    return join(dirname(process.execPath), 'llmtally-keychain');
  }
  return resolve(import.meta.dir, '../../native/bin/darwin-universal/llmtally-keychain');
}

export function invokeNativeWrite(
  helperPath: string,
  keychainPath: string | undefined,
  request: NativeWriteRequest,
  runner: KeychainProcessRunner,
): NativeWriteResult {
  const args = keychainPath === undefined ? [] : ['--keychain', keychainPath];
  let result: KeychainProcessResult;
  try {
    result = runner({
      executable: helperPath,
      args,
      stdin: JSON.stringify({ version: PROTOCOL_VERSION, ...request }),
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof Error) {
      return { kind: 'failure', message: 'native keychain helper could not be started' };
    }
    throw error;
  }
  if (result.exitCode === null) {
    return { kind: 'failure', message: 'native keychain helper timed out or was killed' };
  }
  const response = parseResponse(result.stdout);
  if (response === null) {
    return { kind: 'failure', message: 'native keychain helper returned an invalid protocol response' };
  }
  if (
    result.exitCode === 0 &&
    response.ok &&
    response.status === 0 &&
    (response.phase === 'update' || response.phase === 'add')
  ) {
    return { kind: 'success' };
  }
  const handledNativeFailure =
    result.exitCode === 1 &&
    !response.ok &&
    response.phase !== 'protocol' &&
    response.status !== null &&
    response.status !== 0;
  const handledProtocolFailure =
    result.exitCode === 2 &&
    !response.ok &&
    response.phase === 'protocol' &&
    response.status === null;
  if (handledNativeFailure || handledProtocolFailure) {
    const status = response.status === null ? 'none' : String(response.status);
    return {
      kind: 'failure',
      message: `native keychain helper failed during ${response.phase} (status ${status})`,
      requiresInteraction: response.status !== null && [-25308, -25293, -128].includes(response.status),
    };
  }
  return { kind: 'failure', message: 'native keychain helper returned a contradictory response' };
}

const RESPONSE_PHASES = ['protocol', 'lookup', 'access', 'update', 'add'] as const;
type NativeResponsePhase = (typeof RESPONSE_PHASES)[number];

interface NativeResponse {
  readonly version: 1;
  readonly ok: boolean;
  readonly phase: NativeResponsePhase;
  readonly status: number | null;
}

function parseResponse(stdout: string): NativeResponse | null {
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (body.includes('\n') || body.length === 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value;
  const status = candidate.status;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 4 ||
    !keys.includes('version') ||
    !keys.includes('ok') ||
    !keys.includes('phase') ||
    !keys.includes('status') ||
    candidate.version !== PROTOCOL_VERSION ||
    typeof candidate.ok !== 'boolean' ||
    typeof candidate.phase !== 'string' ||
    !isResponsePhase(candidate.phase) ||
    !(
      status === null ||
      (typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= -2_147_483_648 &&
        status <= 2_147_483_647)
    )
  ) {
    return null;
  }
  return { version: PROTOCOL_VERSION, ok: candidate.ok, phase: candidate.phase, status };
}

function isResponsePhase(value: string): value is NativeResponsePhase {
  return RESPONSE_PHASES.some((phase) => phase === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
