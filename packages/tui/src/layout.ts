export type TuiDensity = 'compact' | 'comfortable';

const COMPACT_HEIGHT = 18;
const COMPACT_WIDTH = 72;

/** Small terminals drop paddings and blank separators (posting-style). */
export function densityFor(width: number, height: number): TuiDensity {
  return height < COMPACT_HEIGHT || width < COMPACT_WIDTH ? 'compact' : 'comfortable';
}
