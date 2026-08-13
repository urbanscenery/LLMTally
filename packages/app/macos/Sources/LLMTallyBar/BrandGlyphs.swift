import AppKit
import SwiftUI

/// The three glyphs whose vendors publish a distinctive monochrome
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

func brandGlyphCommands(agent: String) -> [BrandPathCommand]? {
    switch agent {
    case "claude-code": return CLAUDE_SPARK_24
    case "antigravity": return ANTIGRAVITY_24
    case "opencode": return OPENCODE_24
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
