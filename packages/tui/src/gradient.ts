/**
 * btop-style gradient ramps: 101 precomputed colors for 0..100. Two
 * colors interpolate across the whole range; three colors split at 50
 * (see btop src/btop_theme.cpp gradient generation).
 */

export type RampStops = readonly [string, string] | readonly [string, string, string];

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`invalid theme color "${hex}" (expected #rrggbb)`);
  }
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(rgb: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
  };
}

/** Returns exactly 101 hex colors; index = clamped percent. */
export function buildRamp(stops: RampStops): readonly string[] {
  const colors = stops.map(hexToRgb);
  const ramp: string[] = [];
  for (let index = 0; index <= 100; index += 1) {
    if (colors.length === 2) {
      ramp.push(rgbToHex(mix(colors[0]!, colors[1]!, index / 100)));
    } else if (index <= 50) {
      ramp.push(rgbToHex(mix(colors[0]!, colors[1]!, index / 50)));
    } else {
      ramp.push(rgbToHex(mix(colors[1]!, colors[2]!, (index - 50) / 50)));
    }
  }
  return ramp;
}

export function rampIndex(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percent)));
}
