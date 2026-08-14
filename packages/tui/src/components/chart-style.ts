/**
 * The Overview chart's presentation styles. `block` and `braille` are
 * the classic bar chart at two densities; `heatmap` is a
 * GitHub-contributions calendar. The choice is remembered in ui
 * preferences and picked with `g`.
 */
export const CHART_STYLES = ['block', 'braille', 'heatmap'] as const;

export type ChartStyle = (typeof CHART_STYLES)[number];

export const CHART_STYLE_LABELS: Record<ChartStyle, string> = {
  block: 'Bars (block)',
  braille: 'Bars (braille, 2x density)',
  heatmap: 'Calendar heatmap',
};

export function isChartStyle(value: unknown): value is ChartStyle {
  return typeof value === 'string' && (CHART_STYLES as readonly string[]).includes(value);
}
