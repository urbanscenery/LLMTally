export const TUI_TABS = ['overview', 'accounts', 'agents', 'models', 'search', 'doctor'] as const;
export type TuiTab = (typeof TUI_TABS)[number];

export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Per-tab resource container. `data` survives reloads and failures so
 * the last good screen stays visible while the footer reports state.
 */
export interface ResourceState<T> {
  readonly phase: LoadPhase;
  readonly data: T | null;
  readonly error: string | null;
  readonly updatedAtUtc: number | null;
  readonly invalidated: boolean;
}

export type RefreshReason = 'startup' | 'interval' | 'manual' | 'tab-change';

export type ScanRefreshStatus =
  | 'idle'
  | 'running'
  | 'ok'
  | 'ok-with-warnings'
  | 'busy'
  | 'error';

export interface RefreshState {
  readonly inFlight: boolean;
  readonly pending: boolean;
  readonly reason: RefreshReason | null;
  readonly scanStatus: ScanRefreshStatus;
  /** Recoverable warnings from the last completed scan (0 = clean). */
  readonly warningTotal: number;
  /** Sanitized message of the last scan failure; null when none. */
  readonly lastError: string | null;
  readonly lastCompletedAtUtc: number | null;
  /** Auto-refresh interval; null = off (the initial state). */
  readonly autoIntervalSeconds: number | null;
}

export interface TuiKeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
}

import type { RichFrame } from './rich-text.ts';

/**
 * The only surface the controller talks to; implemented by the opentui
 * adapter in production and by an in-memory fake in tests.
 */
/** Framework-independent mouse event in terminal cell coordinates. */
export interface TuiMouseEvent {
  readonly type: 'down' | 'scroll';
  /** 0-based column and row within the frame. */
  readonly x: number;
  readonly y: number;
  readonly scroll: 'up' | 'down' | null;
}

export interface TuiScreen {
  readonly width: number;
  readonly height: number;
  setFrame(frame: RichFrame): void;
  onKey(handler: (key: TuiKeyEvent) => void): void;
  onMouse?(handler: (event: TuiMouseEvent) => void): void;
  onResize(handler: (width: number, height: number) => void): void;
  destroy(): void;
}
