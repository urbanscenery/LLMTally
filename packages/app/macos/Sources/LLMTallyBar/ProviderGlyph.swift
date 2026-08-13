import SwiftUI
import LLMTallyKit

/// Monochrome provider identity (03_design_spec §7.2): every glyph is
/// drawn in currentColor, never in a provider brand color. The shapes
/// are traced vendor logomarks from BrandGlyphs — the exact paths the
/// status item's composer renders, so the two surfaces cannot drift.
struct ProviderGlyph: View {
    let agent: String
    var size: CGFloat = 14

    var body: some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 16
            if let commands = brandGlyphCommands(agent: agent) {
                let brand = brandGlyphPath(commands, scale: scale * 16 / 24)
                context.fill(brand, with: .color(.primary), style: FillStyle(eoFill: true))
                return
            }
            // unknown agent: neutral circle
            var strokes = Path()
            strokes.addEllipse(in: CGRect(
                x: 2.4 * scale, y: 2.4 * scale,
                width: 11.2 * scale, height: 11.2 * scale))
            context.stroke(strokes, with: .color(.primary),
                           style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
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
