import { AsyncLocalStorage } from 'node:async_hooks';

const interaction = new AsyncLocalStorage<boolean>();

export function withKeychainInteraction<T>(operation: () => T): T {
  return interaction.run(true, operation);
}

export function isKeychainInteractionAllowed(): boolean {
  return interaction.getStore() === true;
}
