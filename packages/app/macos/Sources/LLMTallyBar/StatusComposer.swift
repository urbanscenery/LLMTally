import AppKit
import LLMTallyKit

/// Draws the segment list into one menu-bar-height image. The status
/// button and the Builder preview both call this — the design's
/// "same renderer" rule for the graphical layer.
enum StatusComposer {
    static let barHeight: CGFloat = 16
    private static let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    private static let gap: CGFloat = 6

    static func compose(segments: [StatusSegment], leadingTally: Bool = true) -> NSImage {
        var widths: [CGFloat] = []
        for segment in segments {
            widths.append(width(of: segment))
        }
        let tallyWidth: CGFloat = leadingTally ? 18 : 0
        let contentWidth = widths.reduce(0, +) + CGFloat(max(0, segments.count - 1)) * gap
        let totalWidth = max(tallyWidth + (contentWidth > 0 ? contentWidth + (leadingTally ? gap : 0) : 0), 18)

        let image = NSImage(size: NSSize(width: totalWidth, height: barHeight), flipped: false) { _ in
            var x: CGFloat = 0
            if leadingTally {
                drawTally(at: x)
                x += tallyWidth + (contentWidth > 0 ? gap : 0)
            }
            for (index, segment) in segments.enumerated() {
                draw(segment, at: x)
                x += widths[index] + gap
            }
            return true
        }
        return image
    }

    private static func width(of segment: StatusSegment) -> CGFloat {
        switch segment {
        case .text(let string):
            return attributed(string).size().width.rounded(.up)
        case .rails(let identity, let bars):
            let identityWidth = identity.isEmpty ? 0 : attributed(identity).size().width.rounded(.up) + 3
            return identityWidth + CGFloat(bars.count) * 5 + CGFloat(max(0, bars.count - 1)) * 2
        case .spark(let values, _):
            return CGFloat(values.count) * 3 - 1
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
        case .spark(let values, let money):
            let maximum = max(values.max() ?? 1, 0.000_001)
            let color = money ? NSColor.systemOrange : NSColor.controlAccentColor
            var cursor = x
            for value in values {
                let height = max(1.5, (barHeight - 4) * value / maximum)
                color.setFill()
                NSBezierPath(
                    roundedRect: NSRect(x: cursor, y: 1, width: 2, height: height),
                    xRadius: 1, yRadius: 1).fill()
                cursor += 3
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
        if usedPercent >= CRITICAL_USED_PERCENT { return .systemRed }
        if usedPercent >= WARNING_USED_PERCENT { return .systemOrange }
        return .systemGreen
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
}
