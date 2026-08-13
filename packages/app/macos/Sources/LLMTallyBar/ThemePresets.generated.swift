// Generated from packages/core/src/theme/presets.ts by
// packages/app/scripts/gen-theme-presets.ts — do not edit by hand.
// Regenerate: bun packages/app/scripts/gen-theme-presets.ts

extension Theme {
    /// The cross-surface theme catalog shared with the TUI.
    static let sharedPresets: [Theme] = [
        make("catppuccin", "Catppuccin Mocha", accent: 0xCBA6F7, live: 0xA6E3A1, warn: 0xF9E2AF, crit: 0xF38BA8, actual: 0xF38BA8, background: 0x1E1E2E, dark: true),
        make("onedark", "One Dark", accent: 0xC678DD, live: 0x98C379, warn: 0xE5C07B, crit: 0xE06C75, actual: 0xD19A66, background: 0x282C34, dark: true),
        make("tokyo-night", "Tokyo Night", accent: 0x9D7CD8, live: 0x9ECE6A, warn: 0xE0AF68, crit: 0xF7768E, actual: 0xFF9E64, background: 0x1A1B26, dark: true),
        make("dracula", "Dracula", accent: 0xFF79C6, live: 0x50FA7B, warn: 0xFFB86C, crit: 0xFF5555, actual: 0xBD93F9, background: 0x282A36, dark: true),
        make("monokai", "Monokai", accent: 0xF92672, live: 0xA6E22E, warn: 0xFD971F, crit: 0xC4265E, actual: 0xE6DB74, background: 0x272822, dark: true),
        make("vue", "Vue Dark", accent: 0x42B883, live: 0x42D392, warn: 0xFFC517, crit: 0xED3C50, actual: 0xFF7043, background: 0x273849, dark: true),
        make("material", "Material Dark", accent: 0xC792EA, live: 0xC3E88D, warn: 0xFFCB6B, crit: 0xF07178, actual: 0xF78C6C, background: 0x263238, dark: true),
        make("mono-dark", "Mono Dark", accent: 0xEEEEEE, live: 0xCFCFCF, warn: 0x8A8A8A, crit: 0xFFFFFF, actual: 0xB0B0B0, background: 0x000000, dark: true),
        make("github", "GitHub Light", accent: 0xCF222E, live: 0x1A7F37, warn: 0x9A6700, crit: 0xA40E26, actual: 0xBC4C00, background: 0xFFFFFF, dark: false),
        make("solarized", "Solarized Light", accent: 0x859900, live: 0x2AA198, warn: 0xB58900, crit: 0xDC322F, actual: 0xCB4B16, background: 0xFDF6E3, dark: false),
        make("onelight", "One Light", accent: 0xA626A4, live: 0x50A14F, warn: 0xC18401, crit: 0xE45649, actual: 0x986801, background: 0xFAFAFA, dark: false),
        make("monokai-light", "Monokai Light", accent: 0xE14775, live: 0x269D69, warn: 0xCC7A0A, crit: 0xB02A56, actual: 0xE16032, background: 0xF8EFE7, dark: false),
        make("vue-light", "Vue Light", accent: 0x42B883, live: 0x349469, warn: 0xE7A500, crit: 0xD63C4E, actual: 0xE96900, background: 0xF9F9F9, dark: false),
        make("material-light", "Material Light", accent: 0x7C4DFF, live: 0x91B859, warn: 0xE2931D, crit: 0xE53935, actual: 0xF76D47, background: 0xFAFAFA, dark: false),
        make("mono-light", "Mono Light", accent: 0x111111, live: 0x333333, warn: 0x777777, crit: 0x000000, actual: 0x555555, background: 0xFFFFFF, dark: false),
    ]

    /// Ids stored before the catalog was shared → canonical ids.
    static let legacyThemeIds: [String: String] = [
        "default": "catppuccin",
        "mono": "mono-dark",
        "tokyonight": "tokyo-night",
    ]
}
