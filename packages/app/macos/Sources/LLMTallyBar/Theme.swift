import AppKit
import SwiftUI

/// Appearance presets — the six editor themes fixed in
/// design-tokens.json v1.1.0, plus the system default. A theme swaps
/// accent and state colors; the meaning channels (glyph + text) never
/// depend on it.
struct Theme {
    let id: String
    let name: String
    let accent: Color
    let live: Color
    let warn: Color
    let crit: Color
    let actual: Color
    let nsLive: NSColor
    let nsWarn: NSColor
    let nsCrit: NSColor
    let nsActual: NSColor
    let nsAccent: NSColor
    /// Surface background — a light theme is light everywhere, a dark
    /// theme dark everywhere, regardless of the system appearance.
    /// nil (System) follows macOS.
    let background: Color?
    let colorScheme: ColorScheme?

    static let storageKey = "appearanceTheme"

    static let system = Theme(
        id: "system", name: "System",
        accent: .accentColor, live: .green, warn: .orange, crit: .red, actual: .orange,
        nsLive: .systemGreen, nsWarn: .systemOrange, nsCrit: .systemRed,
        nsActual: .systemOrange, nsAccent: .controlAccentColor,
        background: nil, colorScheme: nil)

    static let presets: [Theme] = [
        system,
        // Light
        make("github", "GitHub Light", accent: 0x0969DA, live: 0x1A7F37, warn: 0x9A6700, crit: 0xCF222E, actual: 0xBC4C00, background: 0xFFFFFF, dark: false),
        make("solarized", "Solarized Light", accent: 0x268BD2, live: 0x859900, warn: 0xB58900, crit: 0xDC322F, actual: 0xCB4B16, background: 0xFDF6E3, dark: false),
        make("onelight", "One Light", accent: 0x4078F2, live: 0x50A14F, warn: 0xC18401, crit: 0xE45649, actual: 0x986801, background: 0xFAFAFA, dark: false),
        make("monokai-light", "Monokai Light", accent: 0x1C8CA8, live: 0x269D69, warn: 0xCC7A0A, crit: 0xE14775, actual: 0xE16032, background: 0xF8EFE7, dark: false),
        make("vue-light", "Vue Light", accent: 0x42B883, live: 0x349469, warn: 0xE7A500, crit: 0xD63C4E, actual: 0xE96900, background: 0xF9F9F9, dark: false),
        make("material-light", "Material Light", accent: 0x39ADB5, live: 0x91B859, warn: 0xE2931D, crit: 0xE53935, actual: 0xF76D47, background: 0xFAFAFA, dark: false),
        make("mono-light", "Mono Light", accent: 0x111111, live: 0x333333, warn: 0x777777, crit: 0x000000, actual: 0x555555, background: 0xFFFFFF, dark: false),
        // Dark
        make("onedark", "One Dark", accent: 0x61AFEF, live: 0x98C379, warn: 0xE5C07B, crit: 0xE06C75, actual: 0xD19A66, background: 0x282C34, dark: true),
        make("dracula", "Dracula", accent: 0xBD93F9, live: 0x50FA7B, warn: 0xFFB86C, crit: 0xFF5555, actual: 0xFF79C6, background: 0x282A36, dark: true),
        make("tokyonight", "Tokyo Night", accent: 0x7AA2F7, live: 0x9ECE6A, warn: 0xE0AF68, crit: 0xF7768E, actual: 0xFF9E64, background: 0x1A1B26, dark: true),
        make("monokai", "Monokai", accent: 0xF92672, live: 0xA6E22E, warn: 0xFD971F, crit: 0xC4265E, actual: 0xE6DB74, background: 0x272822, dark: true),
        make("vue", "Vue Dark", accent: 0x42B883, live: 0x42D392, warn: 0xFFC517, crit: 0xED3C50, actual: 0xFF7043, background: 0x273849, dark: true),
        make("material", "Material Dark", accent: 0x80CBC4, live: 0xC3E88D, warn: 0xFFCB6B, crit: 0xF07178, actual: 0xF78C6C, background: 0x263238, dark: true),
        make("mono", "Mono Dark", accent: 0xEEEEEE, live: 0xCFCFCF, warn: 0x8A8A8A, crit: 0xFFFFFF, actual: 0xB0B0B0, background: 0x000000, dark: true),
    ]

    static func current() -> Theme {
        let id = UserDefaults.standard.string(forKey: storageKey) ?? "system"
        return presets.first { $0.id == id } ?? system
    }

    private static func make(_ id: String, _ name: String,
                             accent: Int, live: Int, warn: Int, crit: Int, actual: Int,
                             background: Int, dark: Bool) -> Theme {
        Theme(id: id, name: name,
              accent: Color(hex: accent), live: Color(hex: live), warn: Color(hex: warn),
              crit: Color(hex: crit), actual: Color(hex: actual),
              nsLive: NSColor(hex: live), nsWarn: NSColor(hex: warn), nsCrit: NSColor(hex: crit),
              nsActual: NSColor(hex: actual), nsAccent: NSColor(hex: accent),
              background: Color(hex: background), colorScheme: dark ? .dark : .light)
    }
}

/// Wraps a window's root so the theme owns the surface: background
/// color and forced light/dark scheme from the Settings panel to the
/// dropdown. System theme leaves both to macOS.
struct ThemedSurface<Content: View>: View {
    @AppStorage(Theme.storageKey) private var themeId = "system"
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        // resolve from the @AppStorage property itself — an unread
        // wrapper is not a re-render dependency, which left cached
        // windows (Settings) stuck on the old theme
        let theme = Theme.presets.first { $0.id == themeId } ?? Theme.system
        if let background = theme.background, let scheme = theme.colorScheme {
            content
                .background(background)
                .environment(\.colorScheme, scheme)
                .tint(theme.accent)
        } else {
            content
                .background(Color(nsColor: .windowBackgroundColor))
        }
    }
}

extension Color {
    init(hex: Int) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

extension NSColor {
    convenience init(hex: Int) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                  green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
