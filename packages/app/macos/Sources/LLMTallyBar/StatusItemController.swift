import AppKit
import LLMTallyKit
import SwiftUI

/// Owns the NSStatusItem and its popover. The visible content is the
/// user's ordered descriptor array rendered against live quota — the
/// tally glyph stays as the leading template image, and the text part
/// comes from `renderStatusItems` (the same logic a Builder preview
/// will reuse).
final class StatusItemController: NSObject, NSPopoverDelegate {
    /// Background cadence for the status text when the popover is
    /// closed. Sidecar/core throttles still gate actual vendor calls.
    private static let refreshIntervalSeconds: TimeInterval = 900

    private let statusItem: NSStatusItem
    private let popover = NSPopover()
    private let descriptorStore = DescriptorStore()
    private var refreshTimer: Timer?
    private var descriptorObserver: NSObjectProtocol?
    private var privacyObserver: NSObjectProtocol?
    // last-good inputs so a Builder edit re-renders without a new fetch
    private var lastQuota: [QuotaSnapshotDTO] = []
    private var lastActive: [String: String?] = [:]

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        statusItem.button?.image = Self.tallyTemplateImage()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)

        popover.behavior = .transient
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: OverviewView())

        refreshStatusText()
        refreshTimer = Timer.scheduledTimer(
            withTimeInterval: Self.refreshIntervalSeconds, repeats: true
        ) { [weak self] _ in
            self?.refreshStatusText()
        }
        descriptorObserver = NotificationCenter.default.addObserver(
            forName: .llmtallyDescriptorsChanged, object: nil, queue: .main
        ) { [weak self] _ in
            self?.renderFromCache()
        }
        privacyObserver = NotificationCenter.default.addObserver(
            forName: .llmtallyPrivacyChanged, object: nil, queue: .main
        ) { [weak self] _ in
            self?.renderFromCache()
        }
    }

    deinit {
        refreshTimer?.invalidate()
        if let descriptorObserver {
            NotificationCenter.default.removeObserver(descriptorObserver)
        }
        if let privacyObserver {
            NotificationCenter.default.removeObserver(privacyObserver)
        }
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

    /// Pulls quota + active accounts and renders the descriptor array
    /// into the button title. Failures keep the previous title —
    /// last-good stays visible, matching the popover's rule.
    private func refreshStatusText() {
        var quota: [QuotaSnapshotDTO]?
        var active: [String: String?]?
        let group = DispatchGroup()

        group.enter()
        SidecarClient.shared.requestDecodable("quota", params: ["refresh": true], as: [QuotaSnapshotDTO].self) { result in
            if case .success(let value) = result { quota = value }
            group.leave()
        }
        group.enter()
        SidecarClient.shared.requestDecodable("activeAccounts", as: [String: String?].self) { result in
            if case .success(let value) = result { active = value }
            group.leave()
        }

        group.notify(queue: .main) { [weak self] in
            guard let self, let quota else { return }
            self.lastQuota = quota
            self.lastActive = active ?? self.lastActive
            self.renderFromCache()
            NotificationManager.shared.process(quota: quota, privacy: PrivacySetting.enabled)
        }
    }

    private func renderFromCache() {
        guard !lastQuota.isEmpty else { return }
        apply(renderStatusItems(
            descriptors: descriptorStore.load(),
            quota: lastQuota,
            activeAccounts: lastActive,
            privacy: PrivacySetting.enabled))
    }

    private func apply(_ rendering: StatusRendering) {
        guard let button = statusItem.button else { return }
        button.attributedTitle = NSAttributedString(
            string: rendering.title.isEmpty ? "" : " \(rendering.title)",
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)])
        button.toolTip = rendering.tooltip
        button.setAccessibilityLabel("LLMTally. \(rendering.tooltip)")
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
