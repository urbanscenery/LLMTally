import SwiftUI
import LLMTallyKit

/// Monochrome provider identity (03_design_spec §7.2): every glyph is
/// drawn in currentColor, never in a provider brand color. These are
/// the same placeholder shapes as prototypes/icons.js; production
/// swaps in licensed monochrome vendor assets behind the same view.
struct ProviderGlyph: View {
    let agent: String
    var size: CGFloat = 14

    var body: some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 16
            let style = StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
            var strokes = Path()
            var fills = Path()

            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: x * scale, y: y * scale)
            }
            func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat) {
                strokes.move(to: point(x1, y1))
                strokes.addLine(to: point(x2, y2))
            }

            switch agent {
            case "claude-code":
                line(8, 1.6, 8, 4.5); line(8, 11.5, 8, 14.4)
                line(1.6, 8, 4.5, 8); line(11.5, 8, 14.4, 8)
                line(3.5, 3.5, 5.5, 5.5); line(10.5, 10.5, 12.5, 12.5)
                line(12.5, 3.5, 10.5, 5.5); line(5.5, 10.5, 3.5, 12.5)
            case "codex":
                let center = point(8, 8)
                for step in 0..<3 {
                    var stadium = Path()
                    stadium.addRoundedRect(
                        in: CGRect(x: 5.3 * scale, y: 1.7 * scale, width: 5.4 * scale, height: 12.6 * scale),
                        cornerSize: CGSize(width: 2.7 * scale, height: 2.7 * scale))
                    let rotation = CGAffineTransform(translationX: center.x, y: center.y)
                        .rotated(by: CGFloat(step) * .pi / 3)
                        .translatedBy(x: -center.x, y: -center.y)
                    strokes.addPath(stadium.applying(rotation))
                }
            case "antigravity":
                strokes.addEllipse(in: CGRect(x: 4.9 * scale, y: 2.7 * scale, width: 6.2 * scale, height: 6.2 * scale))
                strokes.move(to: point(2.6, 12.3))
                strokes.addQuadCurve(to: point(13.4, 12.3), control: point(8, 15.2))
            case "opencode":
                strokes.addRoundedRect(
                    in: CGRect(x: 1.8 * scale, y: 2.6 * scale, width: 12.4 * scale, height: 10.8 * scale),
                    cornerSize: CGSize(width: 2 * scale, height: 2 * scale))
                line(4.6, 6.3, 7.0, 8.2); line(7.0, 8.2, 4.6, 10.1)
                line(8.6, 10.5, 11.4, 10.5)
            case "cline":
                strokes.addRoundedRect(
                    in: CGRect(x: 2.6 * scale, y: 5.4 * scale, width: 10.8 * scale, height: 8 * scale),
                    cornerSize: CGSize(width: 2 * scale, height: 2 * scale))
                line(8, 5.4, 8, 3.5)
                strokes.addEllipse(in: CGRect(x: 7.1 * scale, y: 1.5 * scale, width: 1.8 * scale, height: 1.8 * scale))
                fills.addEllipse(in: CGRect(x: 5 * scale, y: 8.4 * scale, width: 2 * scale, height: 2 * scale))
                fills.addEllipse(in: CGRect(x: 9 * scale, y: 8.4 * scale, width: 2 * scale, height: 2 * scale))
            case "grok":
                line(13.2, 2.2, 4, 13.8)
                line(8.6, 7.9, 3.4, 2.2)
                line(9.9, 10.9, 13.2, 13.8)
            default:
                strokes.addEllipse(in: CGRect(x: 2.4 * scale, y: 2.4 * scale, width: 11.2 * scale, height: 11.2 * scale))
            }

            context.stroke(strokes, with: .color(.primary), style: style)
            context.fill(fills, with: .color(.primary))
        }
        .frame(width: size, height: size)
    }
}

/// The rounded-square stamp box around a glyph — monochrome, tinted
/// from the text color like the prototype `.stamp` class.
struct ProviderStamp: View {
    let agent: String

    var body: some View {
        ProviderGlyph(agent: agent, size: 13)
            .frame(width: 22, height: 22)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.07)))
    }
}

/// Privacy replacement for the stamp: a neutral session-stable alias
/// instead of any identifying glyph (03_design_spec §11).
struct PrivacyStamp: View {
    let alias: String

    var body: some View {
        Text(alias)
            .font(.system(size: 8, weight: .semibold, design: .monospaced))
            .frame(width: 22, height: 22)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.07)))
    }
}
