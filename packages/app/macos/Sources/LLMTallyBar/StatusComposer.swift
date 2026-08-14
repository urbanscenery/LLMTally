import AppKit
import LLMTallyKit

/// Draws the segment list into one menu-bar-height image. The status
/// button and the Builder preview both call this — the design's
/// "same renderer" rule for the graphical layer. When metrics and a
/// budget are supplied, trailing optional segments fold into `+N`
/// (kit's foldSegmentIndices decides; order never changes).
enum StatusComposer {
    static let barHeight: CGFloat = 16
    static let defaultBudget: CGFloat = 336
    /// History spark track width (user-tuned).
    static let sparkTrack: CGFloat = 45
    private static let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    private static let gap: CGFloat = 6

    /// System theme carries no surface of its own — consult the actual
    /// appearance so a dark menu bar gets dark wells like any dark theme.
    private static var systemBarIsDark: Bool {
        NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    /// Neutral dark well for System-on-dark rails and spark backdrops.
    private static let systemDarkWell = NSColor(hex: 0x1E1E1E)

    /// Width of the `+N` fold indicator — exposed so the Builder's
    /// fold note computes with the same number.
    static var indicatorWidth: Double {
        Double(attributed("+9").size().width.rounded(.up))
    }

    /// Content budget once the leading tally mark and its gap are paid
    /// for — `budget` means the whole item, not just the content.
    static func contentBudget(_ budget: Double, leadingTally: Bool = true) -> Double {
        budget - (leadingTally ? 18 + Double(gap) : 0)
    }

    static func compose(segments: [StatusSegment],
                        metrics: [MenuItemMetric]? = nil,
                        budget: CGFloat? = nil,
                        leadingTally: Bool = true) -> NSImage {
        var visibleSegments = segments
        var hiddenCount = 0
        if let metrics, let budget, metrics.count == segments.count {
            let widths = segments.map { Double(width(of: $0)) }
            let fold = foldSegmentIndices(
                metrics: metrics, widths: widths,
                budget: contentBudget(Double(budget), leadingTally: leadingTally),
                gap: Double(gap), indicatorWidth: indicatorWidth)
            if fold.hiddenCount > 0 {
                visibleSegments = fold.visible.map { segments[$0] }
                hiddenCount = fold.hiddenCount
            }
        }
        if hiddenCount > 0 {
            visibleSegments.append(.text("+\(hiddenCount)"))
        }

        let widths = visibleSegments.map { width(of: $0) }
        let tallyWidth: CGFloat = leadingTally ? 18 : 0
        let contentWidth = widths.reduce(0, +) + CGFloat(max(0, visibleSegments.count - 1)) * gap
        let totalWidth = max(tallyWidth + (contentWidth > 0 ? contentWidth + (leadingTally ? gap : 0) : 0), 18)

        let image = NSImage(size: NSSize(width: totalWidth, height: barHeight), flipped: false) { _ in
            var x: CGFloat = 0
            if leadingTally {
                drawTally(at: x)
                x += tallyWidth + (contentWidth > 0 ? gap : 0)
            }
            for (index, segment) in visibleSegments.enumerated() {
                draw(segment, at: x)
                x += widths[index] + gap
            }
            return true
        }
        return image
    }

    static func width(of segment: StatusSegment) -> CGFloat {
        switch segment {
        case .text(let string):
            return attributed(string).size().width.rounded(.up)
        case .glyph:
            return 16
        case .rails(let identity, let bars, _):
            let identityWidth = identity.isEmpty ? 0 : attributed(identity).size().width.rounded(.up) + 3
            return identityWidth + CGFloat(bars.count) * 5 + CGFloat(max(0, bars.count - 1)) * 2
        case .stack(let top, let bottom):
            return max(microAttributed(top).size().width,
                       microAttributed(bottom).size().width).rounded(.up)
        case .spark:
            // fixed track: the range changes density, not width
            return sparkTrack
        case .placeholder:
            return attributed("—").size().width.rounded(.up)
        }
    }

    private static func draw(_ segment: StatusSegment, at x: CGFloat) {
        switch segment {
        case .text(let string):
            drawText(string, at: x)
        case .placeholder:
            drawText("—", at: x)
        case .glyph(let agent):
            drawGlyph(agent: agent, at: x)
        case .rails(let identity, let bars, let remaining):
            var cursor = x
            if !identity.isEmpty {
                drawText(identity, at: cursor)
                cursor += attributed(identity).size().width.rounded(.up) + 3
            }
            for bar in bars {
                let track = NSBezierPath(
                    roundedRect: NSRect(x: cursor, y: 0.5, width: 5, height: barHeight - 1),
                    xRadius: 2, yRadius: 2)
                // the rail track wears the theme surface — dark themes
                // get a dark well, light themes a light one; System has
                // no surface, so follow the actual menu-bar appearance
                (Theme.current().nsBackground
                    ?? (systemBarIsDark ? systemDarkWell
                                        : NSColor.secondaryLabelColor.withAlphaComponent(0.25)))
                    .setFill()
                track.fill()
                // remaining inverts the height; severity color always
                // tracks usage so a nearly-empty rail still warns
                let displayed = remaining ? 100 - bar.usedPercent : bar.usedPercent
                let filledHeight = max(2, (barHeight - 1) * displayed / 100)
                let fill = NSBezierPath(
                    roundedRect: NSRect(x: cursor, y: 0.5, width: 5, height: filledHeight),
                    xRadius: 2, yRadius: 2)
                stateColor(bar.usedPercent).setFill()
                fill.fill()
                cursor += 7
            }
        case .stack(let top, let bottom):
            microAttributed(top).draw(at: NSPoint(x: x, y: 7.5))
            microAttributed(bottom).draw(at: NSPoint(x: x, y: -0.5))
        case .spark(let values, let money, let line):
            let maximum = max(values.max() ?? 1, 0.000_001)
            let theme = Theme.current()
            let color = money ? theme.nsSpend : theme.nsAccent
            let track = sparkTrack
            // the chart sits on its own themed rectangle — previously
            // bare, which washed out on a mismatched menu bar. System
            // brings no surface; a dark menu bar still gets a dark one
            if let surface = theme.nsBackground ?? (systemBarIsDark ? systemDarkWell : nil) {
                surface.setFill()
                NSBezierPath(
                    roundedRect: NSRect(x: x - 2, y: 0, width: track + 4, height: barHeight),
                    xRadius: 3, yRadius: 3).fill()
            }
            if line {
                let path = NSBezierPath()
                path.lineWidth = 1.2
                path.lineJoinStyle = .round
                let step = values.count > 1 ? track / CGFloat(values.count - 1) : 0
                for (index, value) in values.enumerated() {
                    let point = NSPoint(
                        x: x + CGFloat(index) * step,
                        y: 1 + (barHeight - 2) * value / maximum)
                    index == 0 ? path.move(to: point) : path.line(to: point)
                }
                color.setStroke()
                path.stroke()
            } else {
                let step = track / CGFloat(values.count)
                let barWidth = max(0.6, min(step * 0.7, 4))
                for (index, value) in values.enumerated() {
                    let height = max(1.5, (barHeight - 2) * value / maximum)
                    color.setFill()
                    NSBezierPath(
                        roundedRect: NSRect(x: x + CGFloat(index) * step, y: 0.5,
                                            width: barWidth, height: height),
                        xRadius: barWidth / 2, yRadius: barWidth / 2).fill()
                }
            }
        }
    }

    private static func drawText(_ string: String, at x: CGFloat) {
        let attributedString = attributed(string)
        let size = attributedString.size()
        attributedString.draw(at: NSPoint(x: x, y: (barHeight - size.height) / 2))
    }

    private static func attributed(_ string: String) -> NSAttributedString {
        NSAttributedString(string: string, attributes: [
            .font: font,
            .foregroundColor: NSColor.labelColor,
        ])
    }

    /// Micro type for the two-line stacked label (iStat-style).
    private static let microFont = NSFont.monospacedDigitSystemFont(ofSize: 8, weight: .medium)

    private static func microAttributed(_ string: String) -> NSAttributedString {
        NSAttributedString(string: string, attributes: [
            .font: microFont,
            .foregroundColor: NSColor.labelColor,
        ])
    }

    private static func stateColor(_ usedPercent: Double) -> NSColor {
        // healthy = theme ACCENT so the chosen theme reads instantly
        let theme = Theme.current()
        if usedPercent >= CRITICAL_USED_PERCENT { return theme.nsCrit }
        if usedPercent >= WARNING_USED_PERCENT { return theme.nsWarn }
        return theme.nsAccent
    }

    /// The tally mark, drawn in labelColor so it matches the text.
    private static func drawTally(at x: CGFloat) {
        NSColor.labelColor.setStroke()
        for index in 0..<4 {
            let strokeX = x + 3.0 + CGFloat(index) * 4.0
            let stroke = NSBezierPath()
            stroke.lineWidth = 1.6
            stroke.lineCapStyle = .round
            stroke.move(to: NSPoint(x: strokeX, y: 2.5))
            stroke.line(to: NSPoint(x: strokeX, y: 13.5))
            stroke.stroke()
        }
        let slash = NSBezierPath()
        slash.lineWidth = 1.6
        slash.lineCapStyle = .round
        slash.move(to: NSPoint(x: x + 1.0, y: 3.0))
        slash.line(to: NSPoint(x: x + 17.0, y: 13.0))
        slash.stroke()
    }

    /// Monochrome provider glyphs — traced brand logomarks from
    /// BrandGlyphs (shared with ProviderGlyph), filled in labelColor.
    private static func drawGlyph(agent: String, at originX: CGFloat) {
        let scale: CGFloat = barHeight / 16
        NSColor.labelColor.setStroke()
        NSColor.labelColor.setFill()

        // vendors with a real logomark render the traced brand path
        // (shared with ProviderGlyph); unknown agents fall back to a
        // neutral circle
        if let commands = brandGlyphCommands(agent: agent) {
            brandGlyphBezier(commands, originX: originX, scale: barHeight / 24).fill()
            return
        }
        let path = NSBezierPath(ovalIn: NSRect(
            x: originX + 2.4 * scale, y: 2.4 * scale,
            width: 11.2 * scale, height: 11.2 * scale))
        path.lineWidth = 1.4
        path.stroke()
    }
}
