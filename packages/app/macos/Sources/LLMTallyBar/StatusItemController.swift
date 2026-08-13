import AppKit
import LLMTallyKit
import SwiftUI

/// Owns the NSStatusItem and its dropdown. The dropdown is a plain
/// borderless panel — not an NSPopover — so it behaves like other
/// menu-bar apps: rectangular, positioned once before it appears,
/// fully opaque at constant intensity, and closed by any click
/// outside or by losing key.
final class StatusItemController: NSObject, NSWindowDelegate {
    /// Background cadence for the status text when the popover is
    /// closed (Settings → Refresh; default 15 min). Sidecar/core
    /// throttles still gate actual vendor calls.
    private static var refreshIntervalSeconds: TimeInterval {
        TimeInterval(AppConfig.cadenceMinutes * 60)
    }
    private static let panelSize = NSSize(width: 400, height: 560)

    private let statusItem: NSStatusItem
    private var panel: NSPanel?
    private let descriptorStore = DescriptorStore()
    private var refreshTimer: Timer?
    private var descriptorObserver: NSObjectProtocol?
    private var privacyObserver: NSObjectProtocol?
    private var openObserver: NSObjectProtocol?
    private var closeObserver: NSObjectProtocol?
    private var configObserver: NSObjectProtocol?
    private var keyMonitor: Any?
    private var outsideClickMonitor: Any?
    // last-good inputs so a Builder edit re-renders without a new fetch
    private var lastQuota: [QuotaSnapshotDTO] = []
    private var lastBuckets: [ReportBucketDTO] = []
    private var lastHourBuckets: [ReportBucketDTO] = []
    private var lastActive: [String: String?] = [:]
    /// nil = no successful reading yet; an empty map is a real zero.
    private var lastTodayRows: [String: Int]?

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        statusItem.button?.image = Self.tallyTemplateImage()
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)

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
            self?.showPanel()
        }
        closeObserver = NotificationCenter.default.addObserver(
            forName: .llmtallyClosePopover, object: nil, queue: .main
        ) { [weak self] _ in
            self?.closePanel()
        }
    }

    deinit {
        refreshTimer?.invalidate()
        for observer in [descriptorObserver, privacyObserver, openObserver, closeObserver, configObserver] {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
        removeMonitors()
    }

    private func scheduleTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(
            withTimeInterval: Self.refreshIntervalSeconds, repeats: true
        ) { [weak self] _ in
            self?.refreshStatusText()
        }
    }

    // MARK: - panel lifecycle

    @objc private func togglePanel() {
        if panel != nil {
            closePanel()
        } else {
            showPanel()
        }
    }

    private func showPanel() {
        guard panel == nil, let button = statusItem.button else { return }

        let hosting = NSHostingController(rootView: PanelRoot())
        hosting.view.frame = NSRect(origin: .zero, size: Self.panelSize)
        let fresh = KeyablePanel(
            contentRect: NSRect(origin: .zero, size: Self.panelSize),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered, defer: false)
        fresh.contentViewController = hosting
        // opaque rounded content over a clear window: constant color,
        // no vibrancy, no key-state dimming
        fresh.isOpaque = false
        fresh.backgroundColor = .clear
        fresh.hasShadow = true
        fresh.level = .popUpMenu
        fresh.collectionBehavior = [.transient, .ignoresCycle]
        fresh.isReleasedWhenClosed = false
        fresh.setFrame(panelFrame(anchoredTo: button), display: false)
        panel = fresh

        fresh.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        fresh.makeKeyAndOrderFront(nil)
        // NSApp.activate settles asynchronously and can bounce key off
        // the panel for a moment — arming resign-to-close (and the
        // outside-click monitor) immediately closed the panel the
        // instant it appeared. Arm them only once the show settles.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, let shown = self.panel, shown === fresh else { return }
            shown.delegate = self
            shown.makeKey()
            self.installMonitors()
        }
    }

    func closePanel() {
        removeMonitors()
        panel?.orderOut(nil)
        panel = nil
    }

    /// Computed BEFORE the panel appears — no visible reposition. The
    /// anchor is the button's screen rect; a menu-bar manager (Ice)
    /// may have moved it, so the frame clamps into the visible frame.
    private func panelFrame(anchoredTo button: NSStatusBarButton) -> NSRect {
        let size = Self.panelSize
        let buttonRect = button.window.map {
            $0.convertToScreen(button.convert(button.bounds, to: nil))
        } ?? .zero
        let screen = button.window?.screen ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        var x = buttonRect.midX - size.width / 2
        x = min(max(x, visible.minX + 4), visible.maxX - size.width - 4)
        let top = min(buttonRect.minY, visible.maxY) - 4
        let y = max(top - size.height, visible.minY + 4)
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    func windowDidResignKey(_ notification: Notification) {
        // clicking anywhere else (another app, Settings, the desktop)
        // takes key away — the menu-like dismissal the platform expects
        guard (notification.object as? NSPanel) === panel else { return }
        // a sheet (Switch confirmation) taking key is not "outside";
        // closing here would kill the flow the user just started
        if panel?.attachedSheet != nil { return }
        closePanel()
    }

    // MARK: - event monitors

    private func installMonitors() {
        removeMonitors()
        // clicks on other status items or the menu bar do not always
        // move key; a global click is always "outside"
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            // never close over an open sheet — an in-flight switch
            // holds the lock protocol and must finish or roll back
            guard let self, self.panel?.attachedSheet == nil else { return }
            self.closePanel()
        }
        // §9 keyboard while the panel is key: ⌘, / ⌘R / ⌘O handled
        // here, navigation keys routed to the view.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.panel != nil else { return event }
            // a sheet (Switch confirmation) owns its own keys — eating
            // Enter/Escape here made the sheet unconfirmable/uncancelable
            if self.panel?.attachedSheet != nil { return event }
            let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
            if event.modifierFlags.contains(.command) {
                switch key {
                case ",": SettingsWindowController.shared.show(); return nil
                case "o": OpenTUI.launch(); return nil
                case "r":
                    NotificationCenter.default.post(name: .llmtallyKeyCommand, object: "refresh")
                    return nil
                default: return event
                }
            }
            let command: String?
            switch event.keyCode {
            case 53: command = "esc"
            case 36: command = "enter"
            case 126: command = "up"
            case 125: command = "down"
            default: command = key == "s" ? "s" : nil
            }
            guard let command else { return event }
            NotificationCenter.default.post(name: .llmtallyKeyCommand, object: command)
            return nil
        }
    }

    private func removeMonitors() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        if let outsideClickMonitor { NSEvent.removeMonitor(outsideClickMonitor) }
        keyMonitor = nil
        outsideClickMonitor = nil
    }

    // MARK: - status rendering

    /// Pulls quota + report + active accounts and renders the
    /// descriptor array into the button. Failures keep the previous
    /// image — last-good stays visible, matching the popover's rule.
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
        var hourBuckets: [ReportBucketDTO]?
        group.enter()
        SidecarClient.shared.requestDecodable("report", params: OverviewModel.hourReportParams(), as: ReportSummaryDTO.self) { result in
            if case .success(let summary) = result { hourBuckets = summary.buckets }
            group.leave()
        }

        // hybrid collection is the product premise: the menu bar alone
        // must keep the ledger moving (audit GK-41). The sidecar answers
        // serially, so the scan is queued AFTER the four reads above —
        // sending it first parked every read behind a multi-second scan
        // until the 20s deadline killed them (audit C1-01).
        SidecarClient.shared.request("scan") { result in
            if case .failure(let error) = result {
                NSLog("llmtally scan tick failed: %@", error.localizedDescription)
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            guard let overview else {
                // before any data has ever arrived, a failed fetch must
                // not masquerade as the placid startup tally — mark the
                // item and say why in the AX label (audit GK-49)
                if self.lastQuota.isEmpty, let button = self.statusItem.button {
                    button.image = StatusComposer.compose(segments: [.text("!")])
                    let reason = SidecarClient.shared.lastStderrLine ?? "sidecar not answering"
                    button.setAccessibilityLabel("LLMTally: no data — \(reason)")
                }
                return
            }
            self.lastQuota = overview.quota
            self.lastBuckets = overview.report.buckets
            self.lastHourBuckets = hourBuckets ?? self.lastHourBuckets
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
            hourBuckets: lastHourBuckets,
            todayAgentRows: lastTodayRows,
            privacy: PrivacySetting.enabled,
            nominalCost: AppConfig.nominalMode)
        // no leading brand mark (user decision 2026-08-13); the tally
        // glyph only appears while there is nothing else to draw
        button.image = StatusComposer.compose(
            segments: rendering.segments,
            metrics: rendering.metrics,
            budget: StatusComposer.defaultBudget,
            leadingTally: rendering.segments.isEmpty)
        button.imagePosition = .imageOnly
        button.attributedTitle = NSAttributedString(string: "")
        // no hover tooltip (user decision) — the detail stays available
        // to assistive tech through the accessibility label
        button.toolTip = nil
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

/// Borderless panels refuse key status by default; the dropdown needs
/// it for keyboard navigation.
private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Opaque rounded shell around the popover content — constant color,
/// independent of window key state.
private struct PanelRoot: View {
    var body: some View {
        ThemedSurface { OverviewView() }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.primary.opacity(0.16), lineWidth: 0.5))
    }
}
