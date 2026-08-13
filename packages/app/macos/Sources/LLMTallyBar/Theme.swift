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

    static let storageKey = "appearanceTheme"

    static let system = Theme(
        id: "system", name: "System",
        accent: .accentColor, live: .green, warn: .orange, crit: .red, actual: .orange,
        nsLive: .systemGreen, nsWarn: .systemOrange, nsCrit: .systemRed,
        nsActual: .systemOrange, nsAccent: .controlAccentColor)

    static let presets: [Theme] = [
        system,
        make("github", "GitHub Light", accent: 0x0969DA, live: 0x1A7F37, warn: 0x9A6700, crit: 0xCF222E, actual: 0xBC4C00),
        make("solarized", "Solarized Light", accent: 0x268BD2, live: 0x859900, warn: 0xB58900, crit: 0xDC322F, actual: 0xCB4B16),
        make("onelight", "One Light", accent: 0x4078F2, live: 0x50A14F, warn: 0xC18401, crit: 0xE45649, actual: 0x986801),
        make("onedark", "One Dark", accent: 0x61AFEF, live: 0x98C379, warn: 0xE5C07B, crit: 0xE06C75, actual: 0xD19A66),
        make("dracula", "Dracula", accent: 0xBD93F9, live: 0x50FA7B, warn: 0xFFB86C, crit: 0xFF5555, actual: 0xFF79C6),
        make("tokyonight", "Tokyo Night", accent: 0x7AA2F7, live: 0x9ECE6A, warn: 0xE0AF68, crit: 0xF7768E, actual: 0xFF9E64),
    ]

    static func current() -> Theme {
        let id = UserDefaults.standard.string(forKey: storageKey) ?? "system"
        return presets.first { $0.id == id } ?? system
    }

    private static func make(_ id: String, _ name: String,
                             accent: Int, live: Int, warn: Int, crit: Int, actual: Int) -> Theme {
        Theme(id: id, name: name,
              accent: Color(hex: accent), live: Color(hex: live), warn: Color(hex: warn),
              crit: Color(hex: crit), actual: Color(hex: actual),
              nsLive: NSColor(hex: live), nsWarn: NSColor(hex: warn), nsCrit: NSColor(hex: crit),
              nsActual: NSColor(hex: actual), nsAccent: NSColor(hex: accent))
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
