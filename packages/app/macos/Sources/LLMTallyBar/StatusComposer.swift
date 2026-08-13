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
    static let sparkTrack: CGFloat = 80
    private static let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    private static let gap: CGFloat = 6

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
        case .rails(let identity, let bars):
            let identityWidth = identity.isEmpty ? 0 : attributed(identity).size().width.rounded(.up) + 3
            return identityWidth + CGFloat(bars.count) * 5 + CGFloat(max(0, bars.count - 1)) * 2
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
        case .rails(let identity, let bars):
            var cursor = x
            if !identity.isEmpty {
                drawText(identity, at: cursor)
                cursor += attributed(identity).size().width.rounded(.up) + 3
            }
            for bar in bars {
                let track = NSBezierPath(
                    roundedRect: NSRect(x: cursor, y: 1, width: 5, height: barHeight - 2),
                    xRadius: 2, yRadius: 2)
                NSColor.secondaryLabelColor.withAlphaComponent(0.25).setFill()
                track.fill()
                let filledHeight = max(2, (barHeight - 2) * bar.usedPercent / 100)
                let fill = NSBezierPath(
                    roundedRect: NSRect(x: cursor, y: 1, width: 5, height: filledHeight),
                    xRadius: 2, yRadius: 2)
                stateColor(bar.usedPercent).setFill()
                fill.fill()
                cursor += 7
            }
        case .spark(let values, let money, let line):
            let maximum = max(values.max() ?? 1, 0.000_001)
            let theme = Theme.current()
            let color = money ? theme.nsActual : theme.nsAccent
            let track = sparkTrack
            if line {
                let path = NSBezierPath()
                path.lineWidth = 1.2
                path.lineJoinStyle = .round
                let step = values.count > 1 ? track / CGFloat(values.count - 1) : 0
                for (index, value) in values.enumerated() {
                    let point = NSPoint(
                        x: x + CGFloat(index) * step,
                        y: 1.5 + (barHeight - 4) * value / maximum)
                    index == 0 ? path.move(to: point) : path.line(to: point)
                }
                color.setStroke()
                path.stroke()
            } else {
                let step = track / CGFloat(values.count)
                let barWidth = max(0.6, min(step * 0.7, 4))
                for (index, value) in values.enumerated() {
                    let height = max(1.5, (barHeight - 4) * value / maximum)
                    color.setFill()
                    NSBezierPath(
                        roundedRect: NSRect(x: x + CGFloat(index) * step, y: 1,
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

    /// Monochrome provider glyphs — the same placeholder shapes as
    /// ProviderGlyph (SwiftUI) and prototypes/icons.js, in labelColor.
    /// Coordinates are in a 16-unit box, drawn bottom-up (non-flipped).
    private static func drawGlyph(agent: String, at originX: CGFloat) {
        let scale: CGFloat = barHeight / 16
        NSColor.labelColor.setStroke()
        NSColor.labelColor.setFill()

        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            // flip y: source coordinates are top-down like the SwiftUI Canvas
            NSPoint(x: originX + x * scale, y: (16 - y) * scale)
        }
        let path = NSBezierPath()
        path.lineWidth = 1.4
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat) {
            path.move(to: point(x1, y1))
            path.line(to: point(x2, y2))
        }
        func circle(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, into target: NSBezierPath) {
            target.appendOval(in: NSRect(
                x: originX + x * scale, y: (16 - y - h) * scale,
                width: w * scale, height: h * scale))
        }

        switch agent {
        case "claude-code":
            line(8, 1.6, 8, 4.5); line(8, 11.5, 8, 14.4)
            line(1.6, 8, 4.5, 8); line(11.5, 8, 14.4, 8)
            line(3.5, 3.5, 5.5, 5.5); line(10.5, 10.5, 12.5, 12.5)
            line(12.5, 3.5, 10.5, 5.5); line(5.5, 10.5, 3.5, 12.5)
        case "codex":
            let center = NSPoint(x: originX + 8 * scale, y: 8 * scale)
            for step in 0..<3 {
                let stadium = NSBezierPath(
                    roundedRect: NSRect(x: originX + 5.3 * scale, y: 1.7 * scale,
                                        width: 5.4 * scale, height: 12.6 * scale),
                    xRadius: 2.7 * scale, yRadius: 2.7 * scale)
                var transform = AffineTransform(translationByX: center.x, byY: center.y)
                transform.rotate(byRadians: CGFloat(step) * .pi / 3)
                transform.translate(x: -center.x, y: -center.y)
                stadium.transform(using: transform)
                stadium.lineWidth = 1.2
                path.append(stadium)
            }
        case "antigravity":
            circle(4.9, 2.7, 6.2, 6.2, into: path)
            path.move(to: point(2.6, 12.3))
            path.curve(to: point(13.4, 12.3),
                       controlPoint1: point(6, 14.5), controlPoint2: point(10, 14.5))
        case "opencode":
            path.append(NSBezierPath(
                roundedRect: NSRect(x: originX + 1.8 * scale, y: (16 - 13.4) * scale,
                                    width: 12.4 * scale, height: 10.8 * scale),
                xRadius: 2 * scale, yRadius: 2 * scale))
            line(4.6, 6.3, 7.0, 8.2); line(7.0, 8.2, 4.6, 10.1)
            line(8.6, 10.5, 11.4, 10.5)
        case "cline":
            path.append(NSBezierPath(
                roundedRect: NSRect(x: originX + 2.6 * scale, y: (16 - 13.4) * scale,
                                    width: 10.8 * scale, height: 8 * scale),
                xRadius: 2 * scale, yRadius: 2 * scale))
            line(8, 5.4, 8, 3.5)
            circle(7.1, 1.5, 1.8, 1.8, into: path)
            let eyes = NSBezierPath()
            circle(5, 8.4, 2, 2, into: eyes)
            circle(9, 8.4, 2, 2, into: eyes)
            eyes.fill()
        case "grok":
            line(13.2, 2.2, 4, 13.8)
            line(8.6, 7.9, 3.4, 2.2)
            line(9.9, 10.9, 13.2, 13.8)
        default:
            circle(2.4, 2.4, 11.2, 11.2, into: path)
        }
        path.stroke()
    }
}
