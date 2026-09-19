import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { KeychainError } from './keychain.ts';
import type { KeychainPort, KeychainReadResult } from './keychain.ts';

type CredentialSnapshot =
  | { readonly kind: 'found'; readonly value: string }
  | { readonly kind: 'absent' };

type KeychainTarget = {
  readonly service: string;
  readonly snapshot: CredentialSnapshot;
};

const FILE_MODE = 0o600;

function snapshot(result: KeychainReadResult, service: string): CredentialSnapshot {
  if (result.kind === 'error') {
    throw new KeychainError(
      `could not read ${service} before writing (${result.message}); no credentials were changed`,
      'unchanged',
    );
  }
  return result;
}

function readExpected(
  keychain: KeychainPort,
  service: string,
  account: string,
  expected: string,
): void {
  const current = keychain.read(service, account);
  if (current.kind === 'found' && current.value === expected) {
    return;
  }
  throw new KeychainError(
    `credential item ${service} changed after the credential write; refusing to overwrite it`,
    'unknown',
  );
}

function restoreKeychainTarget(
  keychain: KeychainPort,
  account: string,
  target: KeychainTarget,
  expected: string,
): void {
  readExpected(keychain, target.service, account, expected);
  if (target.snapshot.kind === 'found') {
    keychain.write(target.service, account, target.snapshot.value);
  } else {
    keychain.remove(target.service, account);
  }
  const restored = keychain.read(target.service, account);
  if (
    (target.snapshot.kind === 'found' &&
      restored.kind === 'found' &&
      restored.value === target.snapshot.value) ||
    (target.snapshot.kind === 'absent' && restored.kind === 'absent')
  ) {
    return;
  }
  throw new KeychainError(`credential rollback verification failed for ${target.service}`, 'unknown');
}

function restoreKeychainTargets(
  keychain: KeychainPort,
  account: string,
  targets: readonly KeychainTarget[],
  expected: string,
): void {
  const failures: string[] = [];
  for (const target of [...targets].reverse()) {
    try {
      restoreKeychainTarget(keychain, account, target, expected);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new KeychainError(`credential rollback failed (${failures.join('; ')})`, 'unknown');
  }
}

export function writeKeychainCredential(
  keychain: KeychainPort,
  services: readonly string[],
  account: string,
  value: string,
): () => void {
  const targets = services.map((service) => ({
    service,
    snapshot: snapshot(keychain.read(service, account), service),
  }));
  const written: KeychainTarget[] = [];
  for (const target of targets) {
    try {
      keychain.write(target.service, account, value);
      written.push(target);
    } catch (error) {
      try {
        restoreKeychainTargets(keychain, account, written, value);
      } catch (rollbackError) {
        const detail = error instanceof Error ? error.message : String(error);
        const rollbackDetail =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new KeychainError(
          `credential write failed (${detail}) and ${rollbackDetail}`,
          'unknown',
        );
      }
      throw error;
    }
  }
  return () => {
    restoreKeychainTargets(keychain, account, targets, value);
  };
}

function writePrivateBytes(path: string, value: Uint8Array): void {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, value, { mode: FILE_MODE });
    chmodSync(temp, FILE_MODE);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function writeFileCredential(
  path: string,
  value: string,
  write: (path: string, value: string) => void,
): () => void {
  const previous = existsSync(path) ? readFileSync(path) : null;
  write(path, value);
  return () => {
    const current = existsSync(path) ? readFileSync(path) : null;
    if (current === null || !current.equals(Buffer.from(value))) {
      throw new KeychainError(
        'credential file changed after the credential write; refusing to overwrite it',
        'unknown',
      );
    }
    if (previous === null) {
      rmSync(path);
      if (existsSync(path)) {
        throw new KeychainError('credential file rollback verification failed', 'unknown');
      }
      return;
    }
    writePrivateBytes(path, previous);
    if (!readFileSync(path).equals(previous)) {
      throw new KeychainError('credential file rollback verification failed', 'unknown');
    }
  };
}
