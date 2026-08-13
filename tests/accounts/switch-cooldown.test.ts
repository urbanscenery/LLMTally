import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SWITCH_COOLDOWN_SECONDS,
  SwitchCooldownError,
  assertSwitchCooldown,
  recordSwitchCooldown,
  switchCooldownRemaining,
} from '@llmtally/core/accounts/switch-cooldown.ts';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'llmtally-cooldown-')), 'switch-cooldown.json');
}

describe('switch cooldown', () => {
  test('no state file means no cooldown', () => {
    expect(switchCooldownRemaining(tempPath(), 1000)).toBe(0);
  });

  test('a recorded switch opens the settle window and it decays', () => {
    const path = tempPath();
    recordSwitchCooldown(path, 1000);
    expect(switchCooldownRemaining(path, 1000)).toBe(SWITCH_COOLDOWN_SECONDS);
    expect(switchCooldownRemaining(path, 1000 + 10)).toBe(SWITCH_COOLDOWN_SECONDS - 10);
    expect(switchCooldownRemaining(path, 1000 + SWITCH_COOLDOWN_SECONDS)).toBe(0);
  });

  test('assert throws a typed error with the remaining seconds', () => {
    const path = tempPath();
    recordSwitchCooldown(path, 1000);
    try {
      assertSwitchCooldown(path, 1005);
      throw new Error('expected SwitchCooldownError');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SwitchCooldownError);
      expect((error as SwitchCooldownError).remainingSeconds).toBe(SWITCH_COOLDOWN_SECONDS - 5);
    }
    expect(() => assertSwitchCooldown(path, 1000 + SWITCH_COOLDOWN_SECONDS)).not.toThrow();
  });

  test('corrupt bookkeeping fails open', () => {
    const path = tempPath();
    writeFileSync(path, 'not json');
    expect(switchCooldownRemaining(path, 1000)).toBe(0);
    writeFileSync(path, JSON.stringify({ 'claude-code': 'yesterday' }));
    expect(switchCooldownRemaining(path, 1000)).toBe(0);
    writeFileSync(path, JSON.stringify([1000]));
    expect(switchCooldownRemaining(path, 1000)).toBe(0);
  });

  test('a clock jump backwards does not lock switching', () => {
    const path = tempPath();
    recordSwitchCooldown(path, 100_000);
    // now is far behind the recorded stamp — treat as no cooldown
    expect(switchCooldownRemaining(path, 50_000)).toBe(0);
  });
});
