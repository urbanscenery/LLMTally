import AppKit
import SwiftUI

/// Owns the NSStatusItem and its popover. The visible glyph is the tally
/// mark (4 strokes + slash) as a template image so it follows the menu
/// bar appearance — the design spec's monochrome identity rule.
final class StatusItemController: NSObject, NSPopoverDelegate {
    private let statusItem: NSStatusItem
    private let popover = NSPopover()

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()

        statusItem.button?.image = Self.tallyTemplateImage()
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)

        popover.behavior = .transient
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: OverviewView())
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    /// Tally glyph: 4 vertical strokes crossed by the fifth (diagonal).
    private static func tallyTemplateImage() -> NSImage {
        let size = NSSize(width: 18, height: 16)
        let image = NSImage(size: size, flipped: false) { _ in
            NSColor.black.setStroke()
            for index in 0..<4 {
                let x = 3.0 + CGFloat(index) * 4.0
                let stroke = NSBezierPath()
                stroke.lineWidth = 1.6
                stroke.lineCapStyle = .round
                stroke.move(to: NSPoint(x: x, y: 2.5))
                stroke.line(to: NSPoint(x: x, y: 13.5))
                stroke.stroke()
            }
            let slash = NSBezierPath()
            slash.lineWidth = 1.6
            slash.lineCapStyle = .round
            slash.move(to: NSPoint(x: 1.0, y: 3.0))
            slash.line(to: NSPoint(x: 17.0, y: 13.0))
            slash.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }
}
