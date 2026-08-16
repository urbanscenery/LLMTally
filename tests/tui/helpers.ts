import { frameText } from '@llmtally/tui/rich-text.ts';
import type { RichFrame } from '@llmtally/tui/rich-text.ts';
import type { TuiKeyEvent, TuiMouseEvent, TuiScreen } from '@llmtally/tui/types.ts';

/** In-memory TuiScreen: captures frames, replays keys/resizes. */
export class FakeScreen implements TuiScreen {
  width: number;
  height: number;
  /** Plain-text projection, convenient for most assertions. */
  frames: string[][] = [];
  /** Full styled frames for role assertions. */
  richFrames: RichFrame[] = [];
  destroyCount = 0;
  private keyHandler: ((key: TuiKeyEvent) => void) | null = null;
  private mouseHandler: ((event: TuiMouseEvent) => void) | null = null;
  private pasteHandler: ((text: string) => void) | null = null;
  private resizeHandler: ((width: number, height: number) => void) | null = null;

  constructor(width = 80, height = 24) {
    this.width = width;
    this.height = height;
  }

  setFrame(frame: RichFrame): void {
    this.richFrames.push(frame);
    this.frames.push(frameText(frame));
  }

  onKey(handler: (key: TuiKeyEvent) => void): void {
    this.keyHandler = handler;
  }

  onResize(handler: (width: number, height: number) => void): void {
    this.resizeHandler = handler;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  pressKey(name: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}): void {
    this.keyHandler?.({ name, ctrl: modifiers.ctrl === true, shift: modifiers.shift === true });
  }

  onMouse(handler: (event: TuiMouseEvent) => void): void {
    this.mouseHandler = handler;
  }

  onPaste(handler: (text: string) => void): void {
    this.pasteHandler = handler;
  }

  paste(text: string): void {
    this.pasteHandler?.(text);
  }

  click(x: number, y: number): void {
    this.mouseHandler?.({ type: 'down', x, y, scroll: null });
  }

  scroll(direction: 'up' | 'down'): void {
    this.mouseHandler?.({ type: 'scroll', x: 0, y: 5, scroll: direction });
  }

  emitResize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resizeHandler?.(width, height);
  }

  lastFrame(): string[] {
    return this.frames[this.frames.length - 1] ?? [];
  }
}

import { lineText } from '@llmtally/tui/rich-text.ts';
import type { TabViewLine } from '@llmtally/tui/views/shell.ts';

/** Plain-text projection of TabViewLine arrays (string | RichLine). */
export function viewText(lines: readonly TabViewLine[]): string[] {
  return lines.map((line) => (typeof line === 'string' ? line : lineText(line)));
}
