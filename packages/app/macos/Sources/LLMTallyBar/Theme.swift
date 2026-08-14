import AppKit
import SwiftUI

/// Appearance presets — System plus the cross-surface catalog the TUI
/// renders (editor palettes, keyword-color accents; see
/// ThemePresets.generated.swift, generated from
/// packages/core/src/theme/presets.ts). A theme swaps accent and state
/// colors; the meaning channels (glyph + text) never depend on it.
struct Theme {
    let id: String
    let name: String
    let accent: Color
    let live: Color
    let warn: Color
    let crit: Color
    let spend: Color
    /// Quota-cost highlight — third chart hue next to accent/spend.
    let quota: Color
    let nsLive: NSColor
    let nsWarn: NSColor
    let nsCrit: NSColor
    let nsSpend: NSColor
    let nsAccent: NSColor
    /// Surface background — a light theme is light everywhere, a dark
    /// theme dark everywhere, regardless of the system appearance.
    /// nil (System) follows macOS.
    let background: Color?
    let colorScheme: ColorScheme?
    /// Same surface color for AppKit drawing (the status-item backdrop).
    let nsBackground: NSColor?

    var isDark: Bool { colorScheme == .dark }

    static let storageKey = "appearanceTheme"

    static let system = Theme(
        id: "system", name: "System",
        accent: .accentColor, live: .green, warn: .orange, crit: .red, spend: .orange,
        quota: .blue,
        nsLive: .systemGreen, nsWarn: .systemOrange, nsCrit: .systemRed,
        nsSpend: .systemOrange, nsAccent: .controlAccentColor,
        background: nil, colorScheme: nil, nsBackground: nil)

    /// System first, then the shared catalog (ThemePresets.generated.swift).
    static let presets: [Theme] = [system] + sharedPresets

    /// Resolves a stored id, mapping pre-catalog names ("tokyonight",
    /// "mono", "default") so remembered choices survive the rename.
    static func resolve(_ id: String?) -> Theme {
        let raw = id ?? "system"
        let canonical = legacyThemeIds[raw] ?? raw
        return presets.first { $0.id == canonical } ?? system
    }

    static func current() -> Theme {
        resolve(UserDefaults.standard.string(forKey: storageKey))
    }

    /// Called by the generated catalog — keep the signature in lockstep
    /// with gen-theme-presets.ts.
    static func make(_ id: String, _ name: String,
                     accent: Int, live: Int, warn: Int, crit: Int, spend: Int,
                     quota: Int, background: Int, dark: Bool) -> Theme {
        Theme(id: id, name: name,
              accent: Color(hex: accent), live: Color(hex: live), warn: Color(hex: warn),
              crit: Color(hex: crit), spend: Color(hex: spend),
              quota: Color(hex: quota),
              nsLive: NSColor(hex: live), nsWarn: NSColor(hex: warn), nsCrit: NSColor(hex: crit),
              nsSpend: NSColor(hex: spend), nsAccent: NSColor(hex: accent),
              background: Color(hex: background), colorScheme: dark ? .dark : .light,
              nsBackground: NSColor(hex: background))
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
        let theme = Theme.resolve(themeId)
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
