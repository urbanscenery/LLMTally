// Generated from packages/core/src/theme/presets.ts by
// packages/app/scripts/gen-theme-presets.ts — do not edit by hand.
// Regenerate: bun packages/app/scripts/gen-theme-presets.ts

extension Theme {
    /// The cross-surface theme catalog shared with the TUI.
    static let sharedPresets: [Theme] = [
        make("catppuccin", "Catppuccin Mocha", accent: 0xCAA0FD, live: 0xA2E89C, warn: 0xFFE4A9, crit: 0xFB83A5, spend: 0xFB83A5, quota: 0x82E1F2, background: 0x1E1E2E, dark: true),
        make("onedark", "One Dark", accent: 0xCA70E5, live: 0x97C973, warn: 0xEDC273, crit: 0xE9636E, spend: 0xD99A5E, quota: 0x56B0FA, background: 0x282C34, dark: true),
        make("tokyo-night", "Tokyo Night", accent: 0x9B75DF, live: 0x9ED662, warn: 0xE9B15F, crit: 0xFF6E89, spend: 0xFF9E64, quota: 0x7DCFFF, background: 0x1A1B26, dark: true),
        make("dracula", "Dracula", accent: 0xFF79C6, live: 0x4BFF79, warn: 0xFFB86C, crit: 0xFF5555, spend: 0xFFB86C, quota: 0x89EAFF, background: 0x282A36, dark: true),
        make("monokai", "Monokai", accent: 0xFF2070, live: 0xAAF021, warn: 0xFF971D, crit: 0xD01A5B, spend: 0xEFE26B, quota: 0x5CE0F9, background: 0x272822, dark: true),
        make("vue", "Vue Dark", accent: 0x39C184, live: 0x37DE93, warn: 0xFFC517, crit: 0xFA2F46, spend: 0xFF7043, quota: 0x5BB6FF, background: 0x273849, dark: true),
        make("material", "Material Dark", accent: 0xC88BF1, live: 0xC4EF86, warn: 0xFFCB6B, crit: 0xFA6770, spend: 0xFF8864, quota: 0x89DDFF, background: 0x263238, dark: true),
        make("night-owl", "Night Owl", accent: 0x82AAFF, live: 0xAFE45E, warn: 0xF3C586, crit: 0xFB4844, spend: 0xFF8864, quota: 0x78E2CE, background: 0x011627, dark: true),
        make("cobalt2", "Cobalt2", accent: 0xFFC600, live: 0x3AD900, warn: 0xFF9D00, crit: 0xFF2600, spend: 0xFF628C, quota: 0x2AFFDF, background: 0x193549, dark: true),
        make("mono-dark", "Mono Dark", accent: 0xEEEEEE, live: 0xCFCFCF, warn: 0x8A8A8A, crit: 0xFFFFFF, spend: 0xB0B0B0, quota: 0x747474, background: 0x000000, dark: true),
        make("github", "GitHub Light", accent: 0xDC1523, live: 0x128734, warn: 0x9A6700, crit: 0xAF031E, spend: 0x953800, quota: 0x0068E3, background: 0xFFFFFF, dark: false),
        make("solarized", "Solarized Light", accent: 0x859900, live: 0x21AAA0, warn: 0xB58900, crit: 0xE92522, spend: 0xD94508, quota: 0x198DDF, background: 0xFDF6E3, dark: false),
        make("onelight", "One Light", accent: 0xB01CAD, live: 0x4AA749, warn: 0xC28400, crit: 0xF04C3D, spend: 0x996800, quota: 0x3373FF, background: 0xFAFAFA, dark: false),
        make("monokai-light", "Monokai Light", accent: 0xED3B70, live: 0x1DA66A, warn: 0xD67C00, crit: 0xBA2053, spend: 0xEE5A25, quota: 0x1192B3, background: 0xF8EFE7, dark: false),
        make("vue-light", "Vue Light", accent: 0x39C184, live: 0x2D9B6A, warn: 0xE7A500, crit: 0xE23045, spend: 0xE96900, quota: 0x1E73C2, background: 0xF9F9F9, dark: false),
        make("material-light", "Material Light", accent: 0x7C4DFF, live: 0x92BF52, warn: 0xF1960E, crit: 0xF22C28, spend: 0xFF683F, quota: 0x5A80BF, background: 0xFAFAFA, dark: false),
        make("night-owl-light", "Night Owl Light", accent: 0x3D72E1, live: 0x00996D, warn: 0xDBAB00, crit: 0xEA312F, spend: 0xD0605E, quota: 0x21ABA0, background: 0xFBFBFB, dark: false),
        make("cobalt2-light", "Cobalt2 Light", accent: 0x0088FF, live: 0x16A654, warn: 0xC78100, crit: 0xD92600, spend: 0xE1387D, quota: 0x7C37A4, background: 0xEAF2FA, dark: false),
        make("mono-light", "Mono Light", accent: 0x111111, live: 0x333333, warn: 0x777777, crit: 0x000000, spend: 0x555555, quota: 0xA8A8A8, background: 0xFFFFFF, dark: false),
    ]

    /// Ids stored before the catalog was shared → canonical ids.
    static let legacyThemeIds: [String: String] = [
        "default": "catppuccin",
        "mono": "mono-dark",
        "tokyonight": "tokyo-night",
    ]
}
