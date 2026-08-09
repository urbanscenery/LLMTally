/**
 * Claude Code guards its credential files with npm `proper-lockfile`,
 * whose mutex is the atomicity of `mkdir`: whoever creates the lock
 * directory owns it, and a lock whose mtime stopped advancing is stale.
 * llmtally speaks the same protocol so a switch can never interleave
 * with Claude Code's own token refresh.
 *
 * Two rules are load-bearing:
 *   - acquire in the same order Claude Code does, so neither side can
 *     deadlock against the other;
 *   - never do network I/O while holding these locks. Anything slow
 *     inside the critical section stalls the user's live session.
 */
import { mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultClaudeConfigHome } from './credentials.ts';

const TOUCH_INTERVAL_MS = 3000;
const ACQUIRE_TIMEOUT_MS = 9000;
const RETRY_DELAY_MS = 100;

interface LockSpec {
  readonly path: string;
  readonly staleAfterMs: number;
}

export class LockTimeoutError extends Error {
  override readonly name = 'LockTimeoutError';
}

export interface LockHandle {
  release(): void;
}

/** Acquisition order mirrors Claude Code's: refresh, legacy, config. */
export function claudeLockSpecs(home: string = homedir(), configHome?: string): LockSpec[] {
  const config = configHome ?? defaultClaudeConfigHome(home);
  return [
    { path: join(config, '.oauth_refresh.lock'), staleAfterMs: 60_000 },
    { path: join(home, '.claude.lock'), staleAfterMs: 60_000 },
    { path: join(home, '.claude.json.lock'), staleAfterMs: 10_000 },
  ];
}

function isStale(path: string, staleAfterMs: number, nowMs: number): boolean {
  try {
    return nowMs - statSync(path).mtimeMs > staleAfterMs;
  } catch {
    // vanished between the failed mkdir and this stat: treat as free
    return true;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function acquireOne(spec: LockSpec, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(spec.path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }
      if (isStale(spec.path, spec.staleAfterMs, Date.now())) {
        // the holder died; reclaim and retry rather than waiting it out
        rmSync(spec.path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `timed out waiting for ${spec.path} — another Claude Code process is holding it`,
        );
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

export interface AcquireOptions {
  readonly home?: string;
  readonly configHome?: string;
  readonly timeoutMs?: number;
}

/**
 * Acquires every Claude Code lock, releasing what was already taken if
 * a later one cannot be had, so a partial acquisition never leaks.
 */
export async function acquireClaudeLocks(options: AcquireOptions = {}): Promise<LockHandle> {
  const specs = claudeLockSpecs(options.home ?? homedir(), options.configHome);
  const held: string[] = [];
  const release = (): void => {
    for (const path of held.reverse()) {
      rmSync(path, { recursive: true, force: true });
    }
    held.length = 0;
  };

  for (const spec of specs) {
    try {
      await acquireOne(spec, options.timeoutMs ?? ACQUIRE_TIMEOUT_MS);
      held.push(spec.path);
    } catch (error) {
      release();
      throw error;
    }
  }

  // keep the locks looking alive so Claude Code does not reclaim them
  const timer = setInterval(() => {
    const now = new Date();
    for (const path of held) {
      try {
        utimesSync(path, now, now);
      } catch {
        // released concurrently; nothing to keep alive
      }
    }
  }, TOUCH_INTERVAL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  let released = false;
  return {
    release(): void {
      if (released) {
        return;
      }
      released = true;
      clearInterval(timer);
      release();
    },
  };
}
