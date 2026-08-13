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
    /// closed (Settings → Refresh; default 15 min). Sidecar/core
    /// throttles still gate actual vendor calls.
    private static var refreshIntervalSeconds: TimeInterval {
        TimeInterval(AppConfig.cadenceMinutes * 60)
    }

    private let statusItem: NSStatusItem
    /// Recreated per open: reusing one NSPopover across transient
    /// closes is a known source of second-show glitches (wrong
    /// position, blank content) for status-bar apps.
    private var popover: NSPopover?
    private let descriptorStore = DescriptorStore()
    private var refreshTimer: Timer?
    private var descriptorObserver: NSObjectProtocol?
    private var privacyObserver: NSObjectProtocol?
    // last-good inputs so a Builder edit re-renders without a new fetch
    private var lastQuota: [QuotaSnapshotDTO] = []
    private var lastBuckets: [ReportBucketDTO] = []
    private var lastActive: [String: String?] = [:]
    /// nil = no successful reading yet; an empty map is a real zero.
    private var lastTodayRows: [String: Int]?
    private var openObserver: NSObjectProtocol?
    private var configObserver: NSObjectProtocol?

    private func scheduleTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(
            withTimeInterval: Self.refreshIntervalSeconds, repeats: true
        ) { [weak self] _ in
            self?.refreshStatusText()
        }
    }

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        statusItem.button?.image = Self.tallyTemplateImage()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)

        refreshStatusText()
        scheduleTimer()
        configObserver = NotificationCenter.default.addObserver(
            forName: .llmtallyConfigChanged, object: nil, queue: .main
        ) { [weak self] _ in
            self?.scheduleTimer()
            self?.renderFromCache()
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
        openObserver = NotificationCenter.default.addObserver(
            forName: .llmtallyOpenPopover, object: nil, queue: .main
        ) { [weak self] _ in
            self?.showPopover()
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
        if let openObserver {
            NotificationCenter.default.removeObserver(openObserver)
        }
    }

    @objc private func togglePopover() {
        if let shown = popover, shown.isShown {
            shown.performClose(nil)
            return
        }
        showPopover()
    }

    private func showPopover() {
        guard let button = statusItem.button else { return }
        if let shown = popover, shown.isShown { return }

        let fresh = NSPopover()
        fresh.behavior = .transient
        fresh.delegate = self
        fresh.contentViewController = NSHostingController(rootView: OverviewView())
        popover = fresh

        // an accessory app must activate for the popover to become and
        // stay the key window — without it, second shows misbehave
        NSApp.activate(ignoringOtherApps: true)
        // preferredEdge is interpreted in the positioning view's own
        // coordinate space, and NSStatusBarButton is flipped — there
        // .minY is the visual TOP edge, which floated the popover
        // above the menu bar with its head off-screen.
        let bottomEdge: NSRectEdge = button.isFlipped ? .maxY : .minY
        fresh.show(relativeTo: button.bounds, of: button, preferredEdge: bottomEdge)
    }

    func popoverDidShow(_ notification: Notification) {
        // Menu-bar managers (Ice, Bartender) relocate status-item
        // windows when hiding/revealing items, so the anchor rect can
        // be stale by the second open and the popover lands half above
        // the screen. Trust the screen, not the anchor: clamp the
        // popover window into the visible frame after it appears.
        clampPopoverIntoVisibleFrame()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            self?.clampPopoverIntoVisibleFrame()
        }
    }

    private func clampPopoverIntoVisibleFrame() {
        guard
            let window = popover?.contentViewController?.view.window,
            let screen = window.screen ?? statusItem.button?.window?.screen ?? NSScreen.main
        else { return }

        var frame = window.frame
        let visible = screen.visibleFrame  // excludes the menu bar (and notch)
        var changed = false
        if frame.maxY > visible.maxY {
            frame.origin.y = visible.maxY - frame.height
            changed = true
        }
        if frame.minX < visible.minX {
            frame.origin.x = visible.minX + 4
            changed = true
        }
        if frame.maxX > visible.maxX {
            frame.origin.x = visible.maxX - frame.width - 4
            changed = true
        }
        if changed {
            window.setFrame(frame, display: true)
        }
    }

    func popoverDidClose(_ notification: Notification) {
        popover = nil
    }

    /// Pulls quota + active accounts and renders the descriptor array
    /// into the button title. Failures keep the previous title —
    /// last-good stays visible, matching the popover's rule.
    private func refreshStatusText() {
        var overview: OverviewDTO?
        var active: [String: String?]?
        let group = DispatchGroup()

        group.enter()
        SidecarClient.shared.requestDecodable("overview", params: ["refresh": true], as: OverviewDTO.self) { result in
            if case .success(let value) = result { overview = value }
            group.leave()
        }
        group.enter()
        SidecarClient.shared.requestDecodable("activeAccounts", as: [String: String?].self) { result in
            if case .success(let value) = result { active = value }
            group.leave()
        }
        var todayRows: [String: Int]?
        group.enter()
        SidecarClient.shared.requestDecodable("todayByAgent", as: [String: Int].self) { result in
            if case .success(let value) = result { todayRows = value }
            group.leave()
        }

        group.notify(queue: .main) { [weak self] in
            guard let self, let overview else { return }
            self.lastQuota = overview.quota
            self.lastBuckets = overview.report.buckets
            self.lastActive = active ?? self.lastActive
            self.lastTodayRows = todayRows ?? self.lastTodayRows
            self.renderFromCache()
            NotificationManager.shared.process(quota: overview.quota, privacy: PrivacySetting.enabled)
        }
    }

    private func renderFromCache() {
        guard !lastQuota.isEmpty, let button = statusItem.button else { return }
        let rendering = renderStatusSegments(
            descriptors: descriptorStore.load(),
            quota: lastQuota,
            buckets: lastBuckets,
            activeAccounts: lastActive,
            todayAgentRows: lastTodayRows,
            privacy: PrivacySetting.enabled)
        button.image = StatusComposer.compose(
            segments: rendering.segments,
            metrics: rendering.metrics,
            budget: StatusComposer.defaultBudget)
        button.imagePosition = .imageOnly
        button.attributedTitle = NSAttributedString(string: "")
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
