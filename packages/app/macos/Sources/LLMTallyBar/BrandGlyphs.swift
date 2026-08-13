import AppKit
import SwiftUI

/// The glyphs whose vendors publish a distinctive monochrome
/// logomark: traced from the marks themselves (24-unit, top-down SVG
/// coordinates) instead of the earlier hand-drawn placeholders. Both
/// renderers — StatusComposer (AppKit) and ProviderGlyph (SwiftUI) —
/// consume the same command lists, so the menu bar and the popover can
/// never drift apart. All fills use even-odd so OpenCode's frame keeps
/// its hollow center.
enum BrandPathCommand {
    case move(CGFloat, CGFloat)
    case line(CGFloat, CGFloat)
    case curve(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)
    case close
}

/// Anthropic's Claude spark — irregular radiating burst.
let CLAUDE_SPARK_24: [BrandPathCommand] = [
    .move(4.71, 15.96),
    .line(9.43, 13.31),
    .line(9.51, 13.08),
    .line(9.43, 12.95),
    .line(9.20, 12.95),
    .line(8.41, 12.90),
    .line(5.71, 12.83),
    .line(3.37, 12.73),
    .line(1.11, 12.61),
    .line(0.54, 12.49),
    .line(0.00, 11.78),
    .line(0.06, 11.43),
    .line(0.54, 11.11),
    .line(1.22, 11.17),
    .line(2.74, 11.27),
    .line(5.02, 11.43),
    .line(6.67, 11.53),
    .line(9.12, 11.78),
    .line(9.51, 11.78),
    .line(9.56, 11.63),
    .line(9.43, 11.53),
    .line(9.33, 11.43),
    .line(6.97, 9.84),
    .line(4.42, 8.15),
    .line(3.08, 7.18),
    .line(2.36, 6.69),
    .line(1.99, 6.22),
    .line(1.83, 5.22),
    .line(2.49, 4.49),
    .line(3.37, 4.55),
    .line(3.60, 4.61),
    .line(4.49, 5.30),
    .line(6.40, 6.78),
    .line(8.89, 8.61),
    .line(9.25, 8.91),
    .line(9.40, 8.81),
    .line(9.42, 8.74),
    .line(9.25, 8.46),
    .line(7.90, 6.02),
    .line(6.45, 3.53),
    .line(5.81, 2.50),
    .line(5.64, 1.88),
    .line(5.53, 1.15),
    .line(6.28, 0.13),
    .line(6.70, 0.00),
    .line(7.69, 0.13),
    .line(8.11, 0.50),
    .line(8.73, 1.91),
    .line(9.73, 4.14),
    .line(11.29, 7.17),
    .line(11.74, 8.07),
    .line(11.99, 8.90),
    .line(12.08, 9.16),
    .line(12.24, 9.16),
    .line(12.24, 9.01),
    .line(12.36, 7.30),
    .line(12.60, 5.21),
    .line(12.83, 2.51),
    .line(12.91, 1.75),
    .line(13.29, 0.84),
    .line(14.03, 0.35),
    .line(14.62, 0.63),
    .line(15.10, 1.32),
    .line(15.03, 1.76),
    .line(14.75, 3.61),
    .line(14.19, 6.51),
    .line(13.82, 8.46),
    .line(14.03, 8.46),
    .line(14.28, 8.21),
    .line(15.26, 6.91),
    .line(16.91, 4.84),
    .line(17.64, 4.02),
    .line(18.50, 3.12),
    .line(19.04, 2.69),
    .line(20.08, 2.69),
    .line(20.84, 3.82),
    .line(20.50, 4.98),
    .line(19.43, 6.33),
    .line(18.55, 7.47),
    .line(17.29, 9.17),
    .line(16.50, 10.53),
    .line(16.57, 10.64),
    .line(16.76, 10.62),
    .line(19.61, 10.02),
    .line(21.16, 9.74),
    .line(23.00, 9.42),
    .line(23.83, 9.81),
    .line(23.92, 10.21),
    .line(23.59, 11.01),
    .line(21.62, 11.50),
    .line(19.32, 11.96),
    .line(15.88, 12.77),
    .line(15.83, 12.80),
    .line(15.88, 12.86),
    .line(17.43, 13.01),
    .line(18.09, 13.05),
    .line(19.72, 13.05),
    .line(22.74, 13.27),
    .line(23.53, 13.79),
    .line(24.00, 14.43),
    .line(23.92, 14.92),
    .line(22.71, 15.54),
    .line(21.07, 15.15),
    .line(17.24, 14.24),
    .line(15.93, 13.91),
    .line(15.74, 13.91),
    .line(15.74, 14.02),
    .line(16.84, 15.09),
    .line(18.84, 16.90),
    .line(21.35, 19.23),
    .line(21.48, 19.80),
    .line(21.16, 20.26),
    .line(20.82, 20.21),
    .line(18.61, 18.55),
    .line(17.76, 17.81),
    .line(15.83, 16.19),
    .line(15.71, 16.19),
    .line(15.71, 16.36),
    .line(16.15, 17.01),
    .line(18.50, 20.53),
    .line(18.62, 21.61),
    .line(18.45, 21.96),
    .line(17.84, 22.17),
    .line(17.17, 22.05),
    .line(15.80, 20.13),
    .line(14.38, 17.96),
    .line(13.24, 16.02),
    .line(13.10, 16.10),
    .line(12.43, 23.35),
    .line(12.11, 23.72),
    .line(11.38, 24.00),
    .line(10.77, 23.54),
    .line(10.45, 22.79),
    .line(10.77, 21.32),
    .line(11.16, 19.39),
    .line(11.48, 17.86),
    .line(11.76, 15.96),
    .line(11.93, 15.33),
    .line(11.92, 15.29),
    .line(11.78, 15.31),
    .line(10.35, 17.27),
    .line(8.17, 20.22),
    .line(6.44, 22.06),
    .line(6.03, 22.23),
    .line(5.31, 21.86),
    .line(5.38, 21.20),
    .line(5.78, 20.61),
    .line(8.17, 17.57),
    .line(9.61, 15.69),
    .line(10.54, 14.60),
    .line(10.53, 14.44),
    .line(10.47, 14.44),
    .line(4.13, 18.56),
    .line(3.00, 18.71),
    .line(2.51, 18.25),
    .line(2.58, 17.50),
    .line(2.81, 17.26),
    .line(4.71, 15.95),
    .line(4.71, 15.96),
    .close,
]

/// Google Antigravity — center peak with curled wingtips.
let ANTIGRAVITY_24: [BrandPathCommand] = [
    .move(21.75, 22.61),
    .curve(23.09, 23.61, 25.10, 22.94, 23.26, 21.10),
    .curve(17.73, 15.74, 18.90, 1.00, 12.04, 1.00),
    .curve(5.17, 1.00, 6.34, 15.74, 0.82, 21.10),
    .curve(-1.20, 23.11, 0.98, 23.61, 2.32, 22.61),
    .curve(7.51, 19.09, 7.18, 12.89, 12.04, 12.89),
    .curve(16.89, 12.89, 16.56, 19.09, 21.75, 22.61),
    .close,
]

/// OpenCode — thick portrait frame (block cursor); even-odd keeps the
/// inner rectangle hollow.
let OPENCODE_24: [BrandPathCommand] = [
    .move(4, 2), .line(20, 2), .line(20, 22), .line(4, 22), .close,
    .move(8, 6), .line(16, 6), .line(16, 18), .line(8, 18), .close,
]

/// OpenAI Codex — petal badge with a carved-out terminal prompt.
let CODEX_24: [BrandPathCommand] = [
    .move(8.09, 0.46),
    .curve(9.05, 0.06, 10.10, -0.08, 11.13, 0.04),
    .curve(12.46, 0.20, 13.65, 0.76, 14.70, 1.74),
    .curve(14.72, 1.77, 14.76, 1.78, 14.80, 1.77),
    .curve(16.21, 1.42, 17.56, 1.55, 18.86, 2.14),
    .line(18.93, 2.17),
    .line(19.08, 2.24),
    .curve(20.44, 2.95, 21.41, 4.01, 22.00, 5.44),
    .curve(22.28, 6.12, 22.42, 6.83, 22.42, 7.57),
    .curve(22.44, 8.12, 22.38, 8.67, 22.24, 9.20),
    .curve(22.23, 9.25, 22.24, 9.31, 22.28, 9.35),
    .curve(23.07, 10.15, 23.61, 11.15, 23.86, 12.24),
    .curve(24.24, 14.14, 23.85, 15.86, 22.67, 17.38),
    .line(22.49, 17.60),
    .curve(21.72, 18.49, 20.70, 19.14, 19.56, 19.45),
    .curve(19.51, 19.47, 19.47, 19.51, 19.45, 19.56),
    .curve(19.20, 20.29, 18.94, 20.92, 18.46, 21.55),
    .curve(17.26, 23.13, 15.50, 24.01, 13.52, 24.00),
    .curve(11.93, 23.99, 10.53, 23.41, 9.31, 22.26),
    .curve(9.27, 22.23, 9.22, 22.22, 9.17, 22.23),
    .curve(8.65, 22.40, 8.13, 22.42, 7.56, 22.42),
    .curve(6.66, 22.41, 5.77, 22.20, 4.97, 21.79),
    .curve(4.12, 21.38, 3.39, 20.77, 2.82, 20.01),
    .curve(2.62, 19.75, 2.42, 19.49, 2.27, 19.19),
    .curve(2.07, 18.78, 1.90, 18.35, 1.77, 17.91),
    .curve(1.51, 16.91, 1.50, 15.85, 1.76, 14.85),
    .curve(1.77, 14.82, 1.77, 14.80, 1.77, 14.77),
    .curve(1.76, 14.75, 1.75, 14.72, 1.73, 14.71),
    .curve(1.11, 14.08, 0.64, 13.33, 0.35, 12.51),
    .curve(0.16, 12.00, 0.04, 11.46, 0.02, 10.92),
    .curve(-0.03, 10.20, 0.03, 9.48, 0.20, 8.79),
    .curve(0.65, 7.30, 1.51, 6.14, 2.78, 5.29),
    .curve(3.06, 5.10, 3.33, 4.96, 3.58, 4.85),
    .curve(3.87, 4.73, 4.16, 4.63, 4.44, 4.55),
    .curve(4.49, 4.54, 4.52, 4.50, 4.53, 4.46),
    .curve(4.75, 3.68, 5.12, 2.95, 5.63, 2.31),
    .curve(6.32, 1.46, 7.13, 0.85, 8.09, 0.46),
    .close,
    .move(7.28, 8.31),
    .curve(7.05, 7.90, 6.53, 7.76, 6.12, 7.99),
    .curve(5.72, 8.22, 5.58, 8.74, 5.81, 9.15),
    .line(7.50, 12.11),
    .line(5.82, 14.96),
    .curve(5.60, 15.36, 5.74, 15.86, 6.13, 16.09),
    .curve(6.52, 16.33, 7.03, 16.21, 7.27, 15.83),
    .line(9.21, 12.55),
    .curve(9.37, 12.29, 9.37, 11.97, 9.22, 11.70),
    .line(7.28, 8.31),
    .close,
    .move(12.73, 14.55),
    .curve(12.28, 14.57, 11.93, 14.95, 11.93, 15.39),
    .curve(11.93, 15.84, 12.28, 16.22, 12.73, 16.24),
    .line(17.58, 16.24),
    .curve(18.03, 16.22, 18.38, 15.85, 18.38, 15.39),
    .curve(18.38, 14.94, 18.03, 14.57, 17.58, 14.55),
    .line(12.73, 14.55),
    .close,
]

/// Cline — shield-shaped robot face, capsule eyes, antenna ball.
let CLINE_24: [BrandPathCommand] = [
    .move(17.04, 3.99),
    .curve(19.79, 3.99, 22.02, 6.23, 22.02, 8.99),
    .line(22.02, 10.66),
    .line(23.46, 13.56),
    .curve(23.61, 13.84, 23.61, 14.18, 23.46, 14.47),
    .line(22.02, 17.33),
    .line(22.02, 19.00),
    .curve(22.02, 21.76, 19.79, 24.00, 17.04, 24.00),
    .line(7.07, 24.00),
    .curve(4.32, 24.00, 2.09, 21.76, 2.09, 19.00),
    .line(2.09, 17.33),
    .line(0.61, 14.47),
    .curve(0.46, 14.18, 0.46, 13.84, 0.61, 13.55),
    .line(2.09, 10.66),
    .line(2.09, 8.99),
    .curve(2.09, 6.23, 4.32, 3.99, 7.07, 3.99),
    .line(17.04, 3.99),
    .close,
    .move(8.27, 9.60),
    .curve(7.01, 9.60, 5.99, 10.62, 5.99, 11.87),
    .line(5.99, 15.92),
    .curve(6.02, 17.15, 7.03, 18.14, 8.26, 18.14),
    .curve(9.50, 18.14, 10.51, 17.15, 10.54, 15.92),
    .line(10.54, 11.87),
    .curve(10.54, 10.62, 9.52, 9.60, 8.26, 9.60),
    .close,
    .move(15.59, 9.60),
    .curve(14.34, 9.60, 13.32, 10.62, 13.32, 11.87),
    .line(13.32, 15.92),
    .curve(13.32, 17.17, 14.34, 18.19, 15.59, 18.19),
    .curve(16.85, 18.19, 17.87, 17.17, 17.87, 15.92),
    .line(17.87, 11.87),
    .curve(17.87, 11.27, 17.63, 10.69, 17.20, 10.27),
    .curve(16.77, 9.84, 16.19, 9.60, 15.59, 9.60),
    .close,
    .move(12.05, 5.56),
    .curve(13.59, 5.56, 14.83, 4.31, 14.83, 2.78),
    .curve(14.83, 1.24, 13.59, 0.00, 12.05, 0.00),
    .curve(10.52, -0.00, 9.28, 1.24, 9.28, 2.78),
    .curve(9.28, 4.31, 10.52, 5.56, 12.05, 5.56),
    .close,
]

/// Grok — the comet swoosh.
let GROK_24: [BrandPathCommand] = [
    .move(9.27, 15.29),
    .line(17.25, 9.39),
    .curve(17.64, 9.10, 18.20, 9.22, 18.38, 9.66),
    .curve(19.36, 12.03, 18.93, 14.88, 16.97, 16.83),
    .curve(15.02, 18.79, 12.31, 19.22, 9.83, 18.24),
    .line(7.11, 19.50),
    .curve(11.00, 22.16, 15.73, 21.50, 18.68, 18.54),
    .curve(21.02, 16.20, 21.74, 13.01, 21.06, 10.12),
    .line(21.07, 10.13),
    .curve(20.09, 5.90, 21.31, 4.21, 23.82, 0.75),
    .curve(23.88, 0.67, 23.94, 0.58, 24.00, 0.50),
    .line(20.70, 3.81),
    .line(20.70, 3.80),
    .line(9.27, 15.29),
    .move(7.62, 16.72),
    .curve(4.83, 14.05, 5.31, 9.92, 7.69, 7.54),
    .curve(9.46, 5.78, 12.34, 5.06, 14.86, 6.11),
    .line(17.56, 4.86),
    .curve(17.00, 4.45, 16.39, 4.11, 15.74, 3.86),
    .curve(12.39, 2.49, 8.54, 3.27, 5.98, 5.83),
    .curve(3.45, 8.37, 2.65, 12.27, 4.02, 15.59),
    .curve(5.04, 18.08, 3.37, 19.84, 1.68, 21.62),
    .curve(1.08, 22.25, 0.48, 22.88, 0.00, 23.54),
    .line(7.62, 16.73),
]

func brandGlyphCommands(agent: String) -> [BrandPathCommand]? {
    switch agent {
    case "claude-code": return CLAUDE_SPARK_24
    case "antigravity": return ANTIGRAVITY_24
    case "opencode": return OPENCODE_24
    case "codex": return CODEX_24
    case "cline": return CLINE_24
    case "grok": return GROK_24
    default: return nil
    }
}

/// SwiftUI path — top-down like the source coordinates.
func brandGlyphPath(_ commands: [BrandPathCommand], scale: CGFloat) -> Path {
    var path = Path()
    for command in commands {
        switch command {
        case .move(let x, let y):
            path.move(to: CGPoint(x: x * scale, y: y * scale))
        case .line(let x, let y):
            path.addLine(to: CGPoint(x: x * scale, y: y * scale))
        case .curve(let c1x, let c1y, let c2x, let c2y, let x, let y):
            path.addCurve(
                to: CGPoint(x: x * scale, y: y * scale),
                control1: CGPoint(x: c1x * scale, y: c1y * scale),
                control2: CGPoint(x: c2x * scale, y: c2y * scale))
        case .close:
            path.closeSubpath()
        }
    }
    return path
}

/// AppKit path — flipped into the composer's bottom-up 24-unit box.
func brandGlyphBezier(_ commands: [BrandPathCommand], originX: CGFloat, scale: CGFloat) -> NSBezierPath {
    let path = NSBezierPath()
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: originX + x * scale, y: (24 - y) * scale)
    }
    for command in commands {
        switch command {
        case .move(let x, let y):
            path.move(to: point(x, y))
        case .line(let x, let y):
            path.line(to: point(x, y))
        case .curve(let c1x, let c1y, let c2x, let c2y, let x, let y):
            path.curve(to: point(x, y),
                       controlPoint1: point(c1x, c1y),
                       controlPoint2: point(c2x, c2y))
        case .close:
            path.close()
        }
    }
    path.windingRule = .evenOdd
    return path
}
