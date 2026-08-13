/**
 * Cooldown after a completed Claude account switch.
 *
 * macOS Keychain reads are cached by Claude Code for ~30 seconds
 * (measured by claude-swap and echoed in our own switch copy), so for
 * up to half a minute after a switch the running sessions, the vault
 * mirror, and the owner oracle are all still settling onto the new
 * credential generation. A second switch inside that window multiplies
 * the confusion this settle period exists to absorb — flip-flopping
 * mints extra token generations and can capture mid-settle bytes —
 * so both surfaces (menu bar app and TUI) hold the door for a moment.
 *
 * This is a UX guard, not a security boundary: the state file is
 * advisory, and an unreadable or corrupt file fails open (no cooldown)
 * because refusing a switch over a broken byte of bookkeeping would
 * invert the feature's purpose.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Keychain cache (~30s) plus settle margin. */
export const SWITCH_COOLDOWN_SECONDS = 45;

const COOLDOWN_KEY = 'claude-code';

export class SwitchCooldownError extends Error {
  readonly remainingSeconds: number;

  constructor(remainingSeconds: number) {
    super(
      `a switch just completed and the credential stores are still settling — retry in ${remainingSeconds}s`,
    );
    this.name = 'SwitchCooldownError';
    this.remainingSeconds = remainingSeconds;
  }
}

export function defaultSwitchCooldownPath(home: string = homedir()): string {
  return join(home, '.llmtally', 'cache', 'switch-cooldown.json');
}

/** Seconds left before another switch is allowed; 0 when clear. */
export function switchCooldownRemaining(
  path: string,
  nowUtc: number = Math.floor(Date.now() / 1000),
): number {
  let lastSwitchAtUtc: number;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const value =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)[COOLDOWN_KEY]
        : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }
    lastSwitchAtUtc = value;
  } catch {
    // absent or corrupt bookkeeping fails open — see module doc
    return 0;
  }
  // a clock jump backwards must not lock switching for hours
  if (lastSwitchAtUtc > nowUtc + SWITCH_COOLDOWN_SECONDS) {
    return 0;
  }
  return Math.max(0, lastSwitchAtUtc + SWITCH_COOLDOWN_SECONDS - nowUtc);
}

/** Throws SwitchCooldownError while the settle window is open. */
export function assertSwitchCooldown(
  path: string,
  nowUtc: number = Math.floor(Date.now() / 1000),
): void {
  const remaining = switchCooldownRemaining(path, nowUtc);
  if (remaining > 0) {
    throw new SwitchCooldownError(remaining);
  }
}

/** Called after a switch COMPLETES — a failed switch stays retryable. */
export function recordSwitchCooldown(
  path: string,
  nowUtc: number = Math.floor(Date.now() / 1000),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ [COOLDOWN_KEY]: nowUtc }), { mode: 0o600 });
  } catch {
    // bookkeeping only: a failed write means no cooldown, never a
    // failed switch
  }
}
