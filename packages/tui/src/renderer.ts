/**
 * The only module that touches @opentui/core. Wraps a CliRenderer (real
 * or test) behind the framework-independent TuiScreen interface: one
 * full-screen TextRenderable whose content is the composed frame.
 * Semantic roles are resolved to colors HERE and nowhere else.
 */
import { RGBA, StyledText, TextAttributes, TextRenderable, createCliRenderer } from '@opentui/core';
import type { CliRenderer } from '@opentui/core';
import type { TextChunk } from '@opentui/core';

import { sanitizeTerminalLine } from '@llmtally/core/terminal/sanitize.ts';
import { frameText, isPlainFrame } from './rich-text.ts';
import type { RichFrame, StyledSpan } from './rich-text.ts';
import { MONO_THEME } from './theme.ts';
import type { ResolvedTheme } from './theme.ts';
import type { TuiKeyEvent, TuiMouseEvent, TuiScreen } from './types.ts';

const rgbaCache = new Map<string, RGBA>();

function rgbaFor(hex: string): RGBA {
  let cached = rgbaCache.get(hex);
  if (cached === undefined) {
    cached = RGBA.fromHex(hex);
    rgbaCache.set(hex, cached);
  }
  return cached;
}

function spanAttributes(span: StyledSpan, style: { bold?: boolean; dim?: boolean }): number {
  let bits = 0;
  if (span.attributes?.bold === true || style.bold === true) {
    bits |= TextAttributes.BOLD;
  }
  if (span.attributes?.dim === true || style.dim === true) {
    bits |= TextAttributes.DIM;
  }
  if (span.attributes?.underline === true) {
    bits |= TextAttributes.UNDERLINE;
  }
  return bits;
}

function toChunk(span: StyledSpan, theme: ResolvedTheme): TextChunk {
  const style = span.role === undefined ? { color: null } : theme.resolve(span.role);
  const attributes = spanAttributes(span, style);
  // last-line defense: even a span built without the factory cannot
  // smuggle escape bytes into the terminal
  const text = span.text.includes('\u001b') ? sanitizeTerminalLine(span.text) : span.text;
  const chunk = { __isChunk: true, text } as TextChunk;
  if (style.color !== null) {
    (chunk as { fg?: RGBA }).fg = rgbaFor(style.color);
  }
  if (theme.background !== null) {
    (chunk as { bg?: RGBA }).bg = rgbaFor(theme.background);
  }
  if (attributes !== 0) {
    (chunk as { attributes?: number }).attributes = attributes;
  }
  return chunk;
}

const NEWLINE_CHUNK = { __isChunk: true, text: '\n' } as TextChunk;

function toStyledText(frame: RichFrame, theme: ResolvedTheme): StyledText {
  const chunks: TextChunk[] = [];
  frame.forEach((line, index) => {
    for (const span of line) {
      chunks.push(toChunk(span, theme));
    }
    if (index < frame.length - 1) {
      chunks.push(NEWLINE_CHUNK);
    }
  });
  return new StyledText(chunks);
}

export interface WrapRendererOptions {
  /** Fallback size-poll cadence; the event path stays primary. */
  readonly resizePollMs?: number;
  /** Injected in tests; production reads process.stdout. */
  readonly readTerminalSize?: () => { columns: number; rows: number } | null;
}

function readStdoutSize(): { columns: number; rows: number } | null {
  const { columns, rows } = process.stdout;
  return typeof columns === 'number' && typeof rows === 'number' && columns > 0 && rows > 0
    ? { columns, rows }
    : null;
}

export function wrapRenderer(
  renderer: CliRenderer,
  themeProvider: () => ResolvedTheme = (): ResolvedTheme => MONO_THEME,
  options: WrapRendererOptions = {},
): TuiScreen {
  const frame = new TextRenderable(renderer, {
    id: 'llmtally-frame',
    content: '',
    width: '100%',
    height: '100%',
  });
  renderer.root.add(frame);

  const resizePollMs = options.resizePollMs ?? 500;
  const readTerminalSize = options.readTerminalSize ?? readStdoutSize;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;
  let lastBackground: string | null | undefined;
  function applyBackground(theme: ResolvedTheme): void {
    const background = theme.background;
    if (background === lastBackground) {
      return;
    }
    lastBackground = background;
    if (background === null) {
      renderer.resetTerminalBgColor();
      renderer.setBackgroundColor('transparent');
      return;
    }
    renderer.setBackgroundColor(background);
  }
  return {
    get width(): number {
      return renderer.terminalWidth;
    },
    get height(): number {
      return renderer.terminalHeight;
    },
    setFrame(richFrame: RichFrame): void {
      if (destroyed) {
        return;
      }
      const theme = themeProvider();
      applyBackground(theme);
      // mono still renders bold/dim structure — NO_COLOR bans colors only
      frame.content = isPlainFrame(richFrame)
        ? frameText(richFrame).join('\n')
        : toStyledText(richFrame, theme);
      renderer.requestRender();
    },
    onKey(handler: (key: TuiKeyEvent) => void): void {
      renderer.keyInput.on('keypress', (key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
        handler({ name: key.name ?? '', ctrl: key.ctrl === true, shift: key.shift === true });
      });
    },
    onMouse(handler: (event: TuiMouseEvent) => void): void {
      // one full-screen renderable receives every event, so its
      // coordinates are already frame coordinates
      (frame as { onMouse?: (event: unknown) => void }).onMouse = (raw: unknown): void => {
        const event = raw as {
          type?: string;
          x?: number;
          y?: number;
          scroll?: { direction?: string };
        };
        const type = event.type === 'scroll' ? 'scroll' : event.type === 'down' ? 'down' : null;
        if (type === null) {
          return;
        }
        handler({
          type,
          x: Math.max(0, Math.floor(event.x ?? 0)),
          y: Math.max(0, Math.floor(event.y ?? 0)),
          scroll:
            event.scroll?.direction === 'up' ? 'up' : event.scroll?.direction === 'down' ? 'down' : null,
        });
      };
    },

    onResize(handler: (width: number, height: number) => void): void {
      renderer.on('resize', (width: number, height: number) => {
        handler(width, height);
      });
      if (pollTimer !== null) {
        return;
      }
      // belt and braces: SIGWINCH can be missed (nested shells, tmux
      // panes, some terminals), which leaves the layout frozen at the
      // old width. Comparing the real stdout size against what the
      // renderer believes catches every case the event path drops.
      pollTimer = setInterval(() => {
        if (destroyed) {
          return;
        }
        const size = readTerminalSize();
        if (
          size === null ||
          (size.columns === renderer.terminalWidth && size.rows === renderer.terminalHeight)
        ) {
          return;
        }
        const processResize = (
          renderer as unknown as { processResize?: (width: number, height: number) => void }
        ).processResize;
        if (typeof processResize === 'function') {
          try {
            // drives the library's own resize path, which updates the
            // native buffer and re-emits 'resize' to the handler above
            processResize.call(renderer, size.columns, size.rows);
            return;
          } catch {
            // fall through: at least reflow our own frame
          }
        }
        handler(size.columns, size.rows);
      }, resizePollMs);
      if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
      }
    },
    destroy(): void {
      if (!destroyed) {
        destroyed = true;
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        renderer.destroy();
      }
    },
  };
}

export async function createOpentuiScreen(
  themeProvider?: () => ResolvedTheme,
): Promise<TuiScreen> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  return wrapRenderer(renderer, themeProvider);
}
