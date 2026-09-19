export type KeychainReadResult =
  | { readonly kind: 'found'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly message: string; readonly requiresInteraction?: boolean };

export interface KeychainPort {
  readonly available: boolean;
  read(service: string, account: string): KeychainReadResult;
  write(service: string, account: string, secret: string): void;
  remove(service: string, account: string): void;
  findAccount(service: string): string | null;
}

export type KeychainRecovery = 'unchanged' | 'restored' | 'unknown';

export function keychainValue(result: KeychainReadResult): string | null {
  return result.kind === 'found' ? result.value : null;
}

export class KeychainError extends Error {
  override readonly name = 'KeychainError';

  constructor(
    message: string,
    readonly recovery: KeychainRecovery = 'unknown',
    readonly requiresInteraction: boolean = false,
  ) {
    super(message);
  }
}
