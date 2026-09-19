export function parseAccountAttribute(dump: string): string | null {
  const match = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(dump);
  const value = match?.[1];
  return value === undefined || value.length === 0 ? null : value;
}

export function parseKeychainPasswordOutput(output: string): string | null {
  const hex = /^password: 0x([0-9A-F]+)(?: +"[\s\S]*")? *\n$/.exec(output)?.[1];
  if (hex !== undefined) {
    if (hex.length % 2 !== 0) {
      return null;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'));
    } catch (error) {
      if (error instanceof TypeError) {
        return null;
      }
      throw error;
    }
  }
  const quoted = /^password: "([\s\S]*)"\n$/.exec(output)?.[1];
  if (quoted !== undefined) {
    return quoted;
  }
  return output === 'password: \n' ? '' : null;
}

/**
 * `security` exits with the low byte of the OSStatus it hit:
 * errSecItemNotFound (-25300) → 44, errSecInteractionNotAllowed
 * (-25308) → 36, errSecAuthFailed (-25293) → 51, userCanceled (-128)
 * → 128.
 */
const SECURITY_EXIT_ITEM_NOT_FOUND = 44;
const SECURITY_EXITS_NEEDING_APPROVAL: ReadonlySet<number> = new Set([36, 51, 128]);

export interface SecurityReadResult {
  readonly exitCode: number | null;
  readonly stderr?: string;
}

/**
 * Interprets `security find-generic-password -g`. The password line is
 * on stderr; nothing from the process output is ever echoed into an
 * error message, so a failure cannot leak the secret.
 */
export function interpretSecurityRead(
  result: SecurityReadResult,
): { readonly kind: 'found'; readonly value: string } | { readonly kind: 'absent' } | {
  readonly kind: 'error';
  readonly message: string;
  readonly requiresInteraction?: boolean;
} {
  if (result.exitCode === SECURITY_EXIT_ITEM_NOT_FOUND) {
    return { kind: 'absent' };
  }
  // a killed/timed-out reader was almost always parked on an approval
  // dialog nobody answered
  if (result.exitCode === null || SECURITY_EXITS_NEEDING_APPROVAL.has(result.exitCode)) {
    return {
      kind: 'error',
      requiresInteraction: true,
      message: 'Keychain access requires approval. Choose Authorize Keychain in Accounts.',
    };
  }
  if (result.exitCode !== 0) {
    return { kind: 'error', message: `Keychain read failed (security exit ${result.exitCode})` };
  }
  const value = parseKeychainPasswordOutput(result.stderr ?? '');
  if (value === null) {
    return { kind: 'error', message: 'Keychain read returned an unreadable password line' };
  }
  return value.length === 0 ? { kind: 'absent' } : { kind: 'found', value };
}
