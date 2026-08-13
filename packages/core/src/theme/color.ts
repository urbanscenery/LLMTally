/** Minimal #rrggbb ↔ HSL helpers for the theme catalog (no deps). */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function hexToRgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/.test(hex)) {
    throw new Error(`expected #rrggbb, got "${hex}"`);
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(red: number, green: number, blue: number): string {
  const channel = (value: number): string =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function hueToChannel(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) {
    hue += 1;
  }
  if (hue > 1) {
    hue -= 1;
  }
  if (hue < 1 / 6) {
    return p + (q - p) * 6 * hue;
  }
  if (hue < 1 / 2) {
    return q;
  }
  if (hue < 2 / 3) {
    return p + (q - p) * (2 / 3 - hue) * 6;
  }
  return p;
}

/**
 * Multiplies HSL saturation by `factor` (clamped to 1), keeping hue and
 * lightness. Grayscale and already-saturated colors pass through.
 */
export function saturate(hex: string, factor: number): string {
  const [red, green, blue] = hexToRgb(hex).map((value) => value / 255) as [number, number, number];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) {
    return hex;
  }
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) {
    hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
  } else if (max === green) {
    hue = ((blue - red) / delta + 2) / 6;
  } else {
    hue = ((red - green) / delta + 4) / 6;
  }
  const boosted = clamp01(saturation * factor);
  const q =
    lightness < 0.5 ? lightness * (1 + boosted) : lightness + boosted - lightness * boosted;
  const p = 2 * lightness - q;
  return rgbToHex(
    hueToChannel(p, q, hue + 1 / 3),
    hueToChannel(p, q, hue),
    hueToChannel(p, q, hue - 1 / 3),
  );
}
