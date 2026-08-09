import { displayWidth, truncateToWidth } from './text.ts';

/**
 * Framework-independent styled-text IR. Views and components emit
 * semantic roles only; the renderer adapter resolves them to actual
 * colors. Raw ANSI never appears inside span text — width helpers and
 * the sanitizer both stay simple, and truncation can never break an
 * escape sequence.
 */
export type RampName = 'quota' | 'chart';

export type ThemeRole =
  | 'default'
  | 'muted'
  | 'dim'
  | 'accent'
  | 'border'
  | 'selected'
  | 'success'
  | 'warning'
  | 'danger'
  | 'actualCost'
  | 'nominalCost'
  | 'meterTrack'
  | 'tableHeader'
  | 'sortIndicator'
  | 'key'
  | `ramp:${RampName}:${number}`;

export interface SpanAttributes {
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly underline?: boolean;
}

export interface StyledSpan {
  readonly text: string;
  readonly role?: ThemeRole;
  readonly attributes?: SpanAttributes;
}

export type RichLine = readonly StyledSpan[];
export type RichFrame = readonly RichLine[];

const ESC_PATTERN = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]');

/** Spans must never carry escape bytes — styling is roles, not ANSI. */
export function span(text: string, role?: ThemeRole, attributes?: SpanAttributes): StyledSpan {
  if (ESC_PATTERN.test(text)) {
    throw new Error('StyledSpan text must not contain escape characters');
  }
  return role === undefined && attributes === undefined
    ? { text }
    : { text, role, attributes };
}

export function plainLine(text: string): RichLine {
  return [span(text)];
}

export function lineText(line: RichLine): string {
  return line.map((part) => part.text).join('');
}

export function lineWidth(line: RichLine): number {
  return line.reduce((acc, part) => acc + displayWidth(part.text), 0);
}

export function frameText(frame: RichFrame): string[] {
  return frame.map(lineText);
}

/** True when nothing in the frame needs style resolution. */
export function isPlainFrame(frame: RichFrame): boolean {
  return frame.every((line) =>
    line.every((part) => part.role === undefined && part.attributes === undefined),
  );
}

/**
 * Truncates span by span so style boundaries survive; the ellipsis
 * inherits the style of the span it cut. When the cut lands exactly on
 * a span boundary, the trailing spans' text is folded into the width
 * budget so the ellipsis still appears (content never vanishes
 * silently).
 */
export function truncateRichLine(line: RichLine, width: number): RichLine {
  if (width <= 0) {
    return [];
  }
  if (lineWidth(line) <= width) {
    return line;
  }
  const out: StyledSpan[] = [];
  let used = 0;
  for (let index = 0; index < line.length; index += 1) {
    const part = line[index]!;
    const partWidth = displayWidth(part.text);
    if (used + partWidth <= width - 1 && index < line.length - 1) {
      out.push(part);
      used += partWidth;
      continue;
    }
    const remaining = width - used;
    // total exceeds width, so appending the rest guarantees a real cut
    const restText = line
      .slice(index + 1)
      .map((rest) => rest.text)
      .join('');
    const cut = truncateToWidth(part.text + restText, remaining);
    if (cut.length > 0) {
      out.push({ ...part, text: cut });
    }
    break;
  }
  return out;
}

/** Pads or truncates so the line occupies exactly `width` cells. */
export function fitRichLine(line: RichLine, width: number): RichLine {
  const truncated = truncateRichLine(line, width);
  const gap = width - lineWidth(truncated);
  if (gap <= 0) {
    return truncated;
  }
  return [...truncated, span(' '.repeat(gap))];
}

/** Joins fragments (strings become plain spans) into one line. */
export function joinLine(
  ...parts: readonly (string | StyledSpan | RichLine)[]
): RichLine {
  const out: StyledSpan[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      out.push(span(part));
    } else if (Array.isArray(part)) {
      out.push(...(part as RichLine));
    } else {
      out.push(part as StyledSpan);
    }
  }
  return out;
}
