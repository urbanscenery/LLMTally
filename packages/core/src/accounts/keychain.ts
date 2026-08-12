/**
 * macOS Keychain access through the `security` CLI.
 *
 * The binary path is absolute so a PATH-injected `security` cannot
 * intercept secrets, and every call is time-boxed because a locked
 * login keychain on a headless/SSH session makes the CLI wait forever.
 * Secrets go in through stdin (`security -i`) rather than argv so they
 * never appear in the process list.
 *
 * A read answers with three distinct states — found, absent, error —
 * because `security` reports a locked keychain, a timeout, and a
 * missing item through different exit codes, and collapsing them into
 * one "null" is how a switch ends up overwriting a stored credential
 * it merely could not read. Only exit 44 (errSecItemNotFound) means
 * absent; everything else non-zero is an operational error the caller
 * must treat as "unknown", never as "empty".
 */
const SECURITY_BIN = '/usr/bin/security';
const TIMEOUT_MS = 5000;
/** `security` exits 44 (errSecItemNotFound) when the item does not exist. */
const ITEM_NOT_FOUND_EXIT = 44;
/**
 * `security -i` parses stdin with a 4096-byte line buffer; measured on
 * macOS 26, a command line around 2.8 KB stores fine and one around
 * 5.5 KB fails outright. Refusing early turns a confusing "exit 1" into
 * an actionable error and keeps oversized payloads away from a store
 * that would only take part of them.
 */
const MAX_COMMAND_BYTES = 4000;
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]');

export type KeychainReadResult =
  | { readonly kind: 'found'; readonly value: string }
  | { readonly kind: 'absent' }
  /** The keychain could not answer (locked, timed out, denied). */
  | { readonly kind: 'error'; readonly message: string };

export interface KeychainPort {
  readonly available: boolean;
  read(service: string, account: string): KeychainReadResult;
  /** Throws when the secret could not be stored and verified. */
  write(service: string, account: string, secret: string): void;
  /** Throws when the item may still exist (operational failure); absent is success. */
  remove(service: string, account: string): void;
  /** Account attribute of an existing item, so updates hit the same row. */
  findAccount(service: string): string | null;
}

/** The secret when found, else null — for callers where absent and error coincide. */
export function keychainValue(result: KeychainReadResult): string | null {
  return result.kind === 'found' ? result.value : null;
}

export class KeychainError extends Error {
  override readonly name = 'KeychainError';
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** -U updates an existing item instead of failing on a duplicate. */
function storeCommand(service: string, account: string, secret: string): string {
  return `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(secret)}\n`;
}

function runSecurity(
  argv: readonly string[],
  stdin?: string,
): { readonly code: number; readonly stdout: string } {
  const proc = Bun.spawnSync([SECURITY_BIN, ...argv], {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString() };
}

export const macosKeychain: KeychainPort = {
  available: process.platform === 'darwin',

  read(service, account) {
    if (!macosKeychain.available) {
      return { kind: 'absent' };
    }
    const argv = ['find-generic-password', '-s', service];
    if (account.length > 0) {
      argv.push('-a', account);
    }
    argv.push('-w');
    const result = runSecurity(argv);
    if (result.code === 0) {
      // -w prints the secret followed by a newline; nothing else is added
      const value = result.stdout.replace(/\n$/, '');
      return value.length === 0 ? { kind: 'absent' } : { kind: 'found', value };
    }
    if (result.code === ITEM_NOT_FOUND_EXIT) {
      return { kind: 'absent' };
    }
    return {
      kind: 'error',
      message:
        result.code === -1
          ? 'security timed out or was killed (keychain locked?)'
          : `security find-generic-password failed (exit ${result.code})`,
    };
  },

  write(service, account, secret) {
    if (!macosKeychain.available) {
      throw new KeychainError('keychain is only available on macOS');
    }
    // `security -i` reads a command stream: a control character in ANY
    // field ends the line early and turns the rest into a second,
    // attacker-chosen command
    for (const [name, value] of [
      ['service', service],
      ['account', account],
      ['secret', secret],
    ] as const) {
      if (CONTROL_CHARACTERS.test(value)) {
        throw new KeychainError(`keychain ${name} must not contain control characters`);
      }
    }
    const command = storeCommand(service, account, secret);
    if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
      throw new KeychainError(
        `secret is too large for the keychain CLI (${secret.length} characters); the item was left unchanged`,
      );
    }
    // remember what was there so a partial write can be undone; a state
    // we cannot read is a state we must not overwrite
    const previousResult = macosKeychain.read(service, account);
    if (previousResult.kind === 'error') {
      throw new KeychainError(
        `refusing to write: the existing keychain item could not be read (${previousResult.message})`,
      );
    }
    const previous = previousResult.kind === 'found' ? previousResult.value : null;
    const result = runSecurity(['-i'], command);
    if (result.code !== 0) {
      throw new KeychainError(`security add-generic-password failed (exit ${result.code})`);
    }
    const verify = macosKeychain.read(service, account);
    if (verify.kind === 'found' && verify.value === secret) {
      return;
    }
    // the parser accepted the line but stored something else; put the
    // previous value back rather than leaving a truncated credential
    let restored = true;
    if (previous === null) {
      try {
        macosKeychain.remove(service, account);
      } catch {
        restored = false;
      }
    } else {
      const undo = runSecurity(['-i'], storeCommand(service, account, previous));
      const readBack = macosKeychain.read(service, account);
      restored = undo.code === 0 && readBack.kind === 'found' && readBack.value === previous;
    }
    throw new KeychainError(
      restored
        ? 'keychain read-back did not match; the previous value was restored'
        : 'keychain read-back did not match and the previous value could NOT be restored — re-login may be required',
    );
  },

  remove(service, account) {
    if (!macosKeychain.available) {
      return;
    }
    const result = runSecurity(['delete-generic-password', '-s', service, '-a', account]);
    // absent is success; anything else operational means the secret may
    // still exist — a caller about to report "removed" must know that
    if (result.code !== 0 && result.code !== ITEM_NOT_FOUND_EXIT) {
      throw new KeychainError(
        result.code === -1
          ? 'security timed out while deleting the item (keychain locked?)'
          : `security delete-generic-password failed (exit ${result.code})`,
      );
    }
  },

  findAccount(service) {
    if (!macosKeychain.available) {
      return null;
    }
    // attributes only (no -w): nothing is decrypted, so no prompt
    const result = runSecurity(['find-generic-password', '-s', service]);
    if (result.code !== 0) {
      return null;
    }
    return parseAccountAttribute(result.stdout);
  },
};

/** `    "acct"<blob>="someone"` in the attribute dump. */
export function parseAccountAttribute(dump: string): string | null {
  const match = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(dump);
  const value = match?.[1];
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * In-memory port for tests and non-macOS platforms. `maxSecretLength`
 * mirrors the real CLI's line-buffer limit so callers can exercise the
 * oversized-payload path without a real keychain.
 */
export function createMemoryKeychain(
  available = true,
  maxSecretLength = Number.POSITIVE_INFINITY,
): KeychainPort {
  const services = new Map<string, Map<string, string>>();
  return {
    available,
    read(service, account) {
      const value = services.get(service)?.get(account);
      return value === undefined ? { kind: 'absent' } : { kind: 'found', value };
    },
    write(service, account, secret) {
      if (!available) {
        throw new KeychainError('keychain unavailable');
      }
      if (secret.length > maxSecretLength) {
        throw new KeychainError('secret is too large for the keychain CLI');
      }
      const accounts = services.get(service) ?? new Map<string, string>();
      accounts.set(account, secret);
      services.set(service, accounts);
    },
    remove(service, account) {
      services.get(service)?.delete(account);
    },
    findAccount(service) {
      const first = services.get(service)?.keys().next();
      return first === undefined || first.done === true ? null : first.value;
    },
  };
}
