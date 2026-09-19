import type {
  KeychainProcessRequest,
  KeychainProcessResult,
  KeychainProcessRunner,
} from '../packages/core/src/accounts/keychain-native.ts';
import type { KeychainPort } from '../packages/core/src/accounts/keychain.ts';
import { asRecord } from './keychain-switch-qa-support.ts';
import type {
  CreateMacosKeychain,
  WithKeychainInteraction,
} from './keychain-switch-qa-support.ts';

interface FaultQaOptions {
  readonly createMacosKeychain: CreateMacosKeychain;
  readonly withKeychainInteraction: WithKeychainInteraction;
  readonly helperPath: string;
  readonly keychainPath: string;
  readonly actualRunner: KeychainProcessRunner;
}

type Recovery = 'unchanged' | 'restored' | 'unknown';

const ACCOUNT = 'fault-boundary-user';
const PREVIOUS = 'synthetic-previous-value';
const DESIRED = 'synthetic-desired-value';
const THIRD = 'synthetic-third-value';
const SECRET_FRAGMENTS = [PREVIOUS, DESIRED, THIRD] as const;

function writerRequest(request: KeychainProcessRequest, helperPath: string): boolean {
  return (
    request.executable === helperPath &&
    !request.args.some((arg) =>
      arg === '--read' || arg === '--remove' || arg === '--find-account')
  );
}

function expectFound(keychain: KeychainPort, service: string, expected: string): void {
  const result = keychain.read(service, ACCOUNT);
  if (result.kind !== 'found' || result.value !== expected) {
    throw new Error(`fault scenario ${service} read-back mismatch`);
  }
}

function recoveryOf(error: Error): Recovery | null {
  if (!('recovery' in error)) {
    return null;
  }
  const recovery = error.recovery;
  return recovery === 'unchanged' || recovery === 'restored' || recovery === 'unknown'
    ? recovery
    : null;
}

function assertSecretFree(error: Error, requestArgv: readonly string[]): void {
  const surface = [error.message, ...requestArgv].join('\0');
  if (SECRET_FRAGMENTS.some((secret) => surface.includes(secret))) {
    throw new Error('fault boundary exposed synthetic secret data');
  }
}

function expectWriteFailure(
  keychain: KeychainPort,
  service: string,
  expectedRecovery: Recovery,
  requestArgv: readonly string[],
): void {
  try {
    keychain.write(service, ACCOUNT, DESIRED);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    if (recoveryOf(error) !== expectedRecovery) {
      throw new Error(`${service} reported the wrong recovery state`);
    }
    assertSecretFree(error, requestArgv);
    return;
  }
  throw new Error(`${service} unexpectedly succeeded`);
}

function requestWithThirdValue(request: KeychainProcessRequest): KeychainProcessRequest {
  const parsed = request.stdin === undefined ? null : asRecord(JSON.parse(request.stdin));
  if (parsed === null) {
    throw new Error('native request was not a JSON object');
  }
  return { ...request, stdin: JSON.stringify({ ...parsed, secret: THIRD }) };
}

export function runAdapterFaultQa(options: FaultQaOptions): void {
  const base = options.createMacosKeychain({
    helperPath: options.helperPath,
    keychainPath: options.keychainPath,
    runner: options.actualRunner,
  });
  const services = {
    denied: 'llmtally-switch-fault-denied',
    timeout: 'llmtally-switch-fault-timeout',
    killed: 'llmtally-switch-fault-killed',
    third: 'llmtally-switch-fault-third',
  } as const;
  for (const service of Object.values(services)) {
    options.withKeychainInteraction(() => base.write(service, ACCOUNT, PREVIOUS));
  }

  const deniedArgv: string[] = [];
  const deniedRunner: KeychainProcessRunner = (request): KeychainProcessResult => {
    deniedArgv.push(request.executable, ...request.args);
    return writerRequest(request, options.helperPath)
      ? { exitCode: 1, stdout: '{"version":1,"ok":false,"phase":"access","status":-25293}\n' }
      : options.actualRunner(request);
  };
  const denied = options.createMacosKeychain({
    helperPath: options.helperPath, keychainPath: options.keychainPath, runner: deniedRunner,
  });
  options.withKeychainInteraction(() =>
    expectWriteFailure(denied, services.denied, 'unchanged', deniedArgv));
  expectFound(base, services.denied, PREVIOUS);

  const timeoutArgv: string[] = [];
  const timeoutRunner: KeychainProcessRunner = (request): KeychainProcessResult => {
    timeoutArgv.push(request.executable, ...request.args);
    if (!writerRequest(request, options.helperPath)) {
      return options.actualRunner(request);
    }
    options.actualRunner(request);
    return { exitCode: null, stdout: '' };
  };
  const timeout = options.createMacosKeychain({
    helperPath: options.helperPath, keychainPath: options.keychainPath, runner: timeoutRunner,
  });
  options.withKeychainInteraction(() =>
    expectWriteFailure(timeout, services.timeout, 'restored', timeoutArgv));
  expectFound(base, services.timeout, PREVIOUS);

  const killedArgv: string[] = [];
  const killedRunner: KeychainProcessRunner = (request): KeychainProcessResult => {
    killedArgv.push(request.executable, ...request.args);
    if (!writerRequest(request, options.helperPath)) {
      return options.actualRunner(request);
    }
    options.actualRunner(request);
    return { exitCode: 9, stdout: '' };
  };
  const killed = options.createMacosKeychain({
    helperPath: options.helperPath, keychainPath: options.keychainPath, runner: killedRunner,
  });
  options.withKeychainInteraction(() =>
    expectWriteFailure(killed, services.killed, 'restored', killedArgv));
  expectFound(base, services.killed, PREVIOUS);

  const thirdArgv: string[] = [];
  const thirdRunner: KeychainProcessRunner = (request): KeychainProcessResult => {
    thirdArgv.push(request.executable, ...request.args);
    return writerRequest(request, options.helperPath)
      ? options.actualRunner(requestWithThirdValue(request))
      : options.actualRunner(request);
  };
  const third = options.createMacosKeychain({
    helperPath: options.helperPath, keychainPath: options.keychainPath, runner: thirdRunner,
  });
  options.withKeychainInteraction(() =>
    expectWriteFailure(third, services.third, 'unknown', thirdArgv));
  expectFound(base, services.third, THIRD);

  for (const service of Object.values(services)) {
    options.withKeychainInteraction(() => base.remove(service, ACCOUNT));
  }
}
