/**
 * Emits the shared theme catalog (@llmtally/core/theme/presets.ts) as
 * Swift so the menu-bar app compiles the same palettes the TUI renders.
 * The generated file is committed; tests/theme/catalog.test.ts fails
 * when it drifts from the catalog, and bundle.sh regenerates it before
 * every build.
 */
import { APP_LEGACY_THEME_IDS, THEME_PRESETS } from '@llmtally/core/theme/presets.ts';

export const GENERATED_SWIFT_PATH = new URL(
  '../macos/Sources/LLMTallyBar/ThemePresets.generated.swift',
  import.meta.url,
).pathname;

function hexLiteral(hex: string): string {
  if (!/^#[0-9a-f]{6}$/.test(hex)) {
    throw new Error(`theme color must be #rrggbb, got "${hex}"`);
  }
  return `0x${hex.slice(1).toUpperCase()}`;
}

export function renderThemePresetsSwift(): string {
  const presets = THEME_PRESETS.map((preset) => {
    const colors = preset.colors;
    const args = [
      `"${preset.id}"`,
      `"${preset.label}"`,
      `accent: ${hexLiteral(colors.accent)}`,
      `live: ${hexLiteral(colors.live)}`,
      `warn: ${hexLiteral(colors.warn)}`,
      `crit: ${hexLiteral(colors.crit)}`,
      `spend: ${hexLiteral(colors.spend)}`,
      // surfaces fall back to spend when a palette leaves quota out
      `quota: ${hexLiteral(colors.quota ?? colors.spend)}`,
      `background: ${hexLiteral(colors.background)}`,
      `dark: ${preset.appearance === 'dark'}`,
    ];
    return `        make(${args.join(', ')}),`;
  });
  const legacy = Object.entries(APP_LEGACY_THEME_IDS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([from, to]) => `        "${from}": "${to}",`);
  return [
    '// Generated from packages/core/src/theme/presets.ts by',
    '// packages/app/scripts/gen-theme-presets.ts — do not edit by hand.',
    '// Regenerate: bun packages/app/scripts/gen-theme-presets.ts',
    '',
    'extension Theme {',
    '    /// The cross-surface theme catalog shared with the TUI.',
    '    static let sharedPresets: [Theme] = [',
    ...presets,
    '    ]',
    '',
    '    /// Ids stored before the catalog was shared → canonical ids.',
    '    static let legacyThemeIds: [String: String] = [',
    ...legacy,
    '    ]',
    '}',
    '',
  ].join('\n');
}

if (import.meta.main) {
  await Bun.write(GENERATED_SWIFT_PATH, renderThemePresetsSwift());
  console.log(`wrote ${GENERATED_SWIFT_PATH}`);
}
