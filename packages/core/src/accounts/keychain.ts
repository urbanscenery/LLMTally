/**
 * macOS Keychain access through the `security` CLI.
 *
 * The binary path is absolute so a PATH-injected `security` cannot
 * intercept secrets, and every call is time-boxed because a locked
 * login keychain on a headless/SSH session makes the CLI wait forever.
 * Secrets go in through stdin (`security -i`) rather than argv so they
 * never appear in the process list.
 *
 * A read that fails returns null. Callers about to overwrite a backup
 * must treat null as "unknown", never as "empty": `security` reports a
 * timeout the same way it reports a missing item, and letting that
 * destroy a stored credential is exactly the failure mode this whole
 * module exists to avoid.
 */
const SECURITY_BIN = '/usr/bin/security';
const TIMEOUT_MS = 5000;
/**
 * `security -i` parses stdin with a 4096-byte line buffer; measured on
 * macOS 26, a command line around 2.8 KB stores fine and one around
 * 5.5 KB fails outright. Refusing early turns a confusing "exit 1" into
 * an actionable error and keeps oversized payloads away from a store
 * that would only take part of them.
 */
const MAX_COMMAND_BYTES = 4000;
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]');

export interface KeychainPort {
  readonly available: boolean;
  read(service: string, account: string): string | null;
  /** Throws when the secret could not be stored and verified. */
  write(service: string, account: string, secret: string): void;
  remove(service: string, account: string): void;
  /** Account attribute of an existing item, so updates hit the same row. */
  findAccount(service: string): string | null;
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
      return null;
    }
    const argv = ['find-generic-password', '-s', service];
    if (account.length > 0) {
      argv.push('-a', account);
    }
    argv.push('-w');
    const result = runSecurity(argv);
    if (result.code !== 0) {
      return null;
    }
    // -w prints the secret followed by a newline; nothing else is added
    const value = result.stdout.replace(/\n$/, '');
    return value.length === 0 ? null : value;
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
    // remember what was there so a partial write can be undone
    const previous = macosKeychain.read(service, account);
    const result = runSecurity(['-i'], command);
    if (result.code !== 0) {
      throw new KeychainError(`security add-generic-password failed (exit ${result.code})`);
    }
    if (macosKeychain.read(service, account) === secret) {
      return;
    }
    // the parser accepted the line but stored something else; put the
    // previous value back rather than leaving a truncated credential
    let restored = true;
    if (previous === null) {
      macosKeychain.remove(service, account);
    } else {
      const undo = runSecurity(['-i'], storeCommand(service, account, previous));
      restored = undo.code === 0 && macosKeychain.read(service, account) === previous;
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
    runSecurity(['delete-generic-password', '-s', service, '-a', account]);
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
      return services.get(service)?.get(account) ?? null;
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
