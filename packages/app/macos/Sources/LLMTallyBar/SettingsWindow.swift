import AppKit
import LLMTallyKit
import ServiceManagement
import SwiftUI

extension Notification.Name {
    /// Posted by the Builder after persisting descriptor changes so the
    /// status item re-renders without waiting for the next quota tick.
    static let llmtallyDescriptorsChanged = Notification.Name("llmtallyDescriptorsChanged")
    /// Posted when the privacy toggle flips — one policy across the
    /// status item, popover, tooltips, and notifications.
    static let llmtallyPrivacyChanged = Notification.Name("llmtallyPrivacyChanged")
    /// Posted when a delivered notification is clicked — the status
    /// item opens its popover in response.
    static let llmtallyOpenPopover = Notification.Name("llmtallyOpenPopover")
    /// Posted for config that the status item must re-apply itself
    /// (refresh cadence).
    static let llmtallyConfigChanged = Notification.Name("llmtallyConfigChanged")
    /// Keyboard routing while the popover is open (§9). Object is the
    /// command string: esc / s / refresh / up / down / enter.
    static let llmtallyKeyCommand = Notification.Name("llmtallyKeyCommand")
    /// The popover view asks the controller to close it (Esc at root).
    static let llmtallyClosePopover = Notification.Name("llmtallyClosePopover")
}

/// Single source for the privacy switch (03_design_spec §11).
enum PrivacySetting {
    static let key = "privacyMode"
    static var enabled: Bool { UserDefaults.standard.bool(forKey: key) }
}

/// UserDefaults-backed app configuration applied at launch and on
/// change (thresholds feed LLMTallyKit's shared values).
enum AppConfig {
    static let warningKey = "thresholdWarning"
    static let criticalKey = "thresholdCritical"
    static let cadenceKey = "refreshCadenceMinutes"
    static let costModeKey = "costMode"

    static func applyThresholds() {
        let defaults = UserDefaults.standard
        let warning = defaults.object(forKey: warningKey) as? Double ?? 70
        let critical = defaults.object(forKey: criticalKey) as? Double ?? 90
        QuotaThresholds.warning = warning
        QuotaThresholds.critical = max(critical, warning + 1)
    }

    static var cadenceMinutes: Int {
        let value = UserDefaults.standard.integer(forKey: cadenceKey)
        return value > 0 ? value : 15
    }

    static var nominalMode: Bool {
        UserDefaults.standard.string(forKey: costModeKey) == "nominal"
    }
}

/// One-shot deep-link target: a clicked notification names its agent,
/// the next popover open lands on that provider's detail.
enum PendingNavigation {
    static var agent: String?
    static func consume() -> String? {
        defer { agent = nil }
        return agent
    }
}

/// Overview row visibility (Settings → Overview). Never mutates the
/// Builder's descriptors.
enum HiddenAgents {
    static let key = "hiddenAgents"
    static func all() -> Set<String> {
        Set((UserDefaults.standard.string(forKey: key) ?? "")
            .split(separator: ",").map(String.init))
    }
    static func set(_ agents: Set<String>) {
        UserDefaults.standard.set(agents.sorted().joined(separator: ","), forKey: key)
    }
}

/// Manual Overview row order (Settings → Overview). nil = the default
/// attention-first ordering.
enum ProviderOrder {
    static let key = "providerOrder"
    static func saved() -> [String]? {
        guard let raw = UserDefaults.standard.string(forKey: key), !raw.isEmpty else { return nil }
        return raw.split(separator: ",").map(String.init)
    }
    static func set(_ agents: [String]?) {
        if let agents, !agents.isEmpty {
            UserDefaults.standard.set(agents.joined(separator: ","), forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}

/// Settings lives in its own window (03_design_spec §1) — never inside
/// the popover. The Builder is a scene of this window.
final class SettingsWindowController {
    static let shared = SettingsWindowController()
    private var window: NSWindow?

    func show() {
        if window == nil {
            let hosting = NSHostingController(rootView: ThemedSurface { SettingsView() })
            let window = NSWindow(contentViewController: hosting)
            window.title = "LLMTally Settings"
            window.setContentSize(NSSize(width: 860, height: 700))
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.isReleasedWhenClosed = false
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
    }
}

struct SettingsView: View {
    enum Pane: String, CaseIterable {
        case general = "General"
        case menubar = "Menu bar"
        case overviewRows = "Overview"
        case accounts = "Accounts"
        case thresholds = "Thresholds"
        case refresh = "Refresh"
        case cost = "Cost"
        case privacy = "Privacy"
        case appearance = "Appearance"
    }

    @State private var pane: Pane = .menubar

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Pane.allCases, id: \.self) { candidate in
                    Button {
                        pane = candidate
                    } label: {
                        Text(candidate.rawValue)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(pane == candidate ? Color.accentColor.opacity(0.18) : .clear))
                            // the whole row hits, not just the glyphs —
                            // a clear background is not hit-testable
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(8)
            .frame(width: 180)
            .background(Color.primary.opacity(0.03))

            Divider()

            Group {
                switch pane {
                case .general: GeneralPane()
                // the Builder IS the pane — no summary detour
                case .menubar: BuilderView()
                case .overviewRows: OverviewRowsPane()
                case .accounts: AccountsPane()
                case .thresholds: ThresholdsPane()
                case .refresh: RefreshPane()
                case .cost: CostPane()
                case .privacy: PrivacyPane()
                case .appearance: AppearancePane()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct GeneralPane: View {
    @State private var launchAtLogin = false
    private var isBundled: Bool { Bundle.main.bundleIdentifier != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("General").font(.title2.weight(.semibold))
            Text("The menubar app reads @llmtally/core through the sidecar. It never parses the TUI.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Launch at login")
                Spacer()
                Toggle("", isOn: $launchAtLogin)
                    .disabled(!isBundled)
                    .onChange(of: launchAtLogin) { enabled in
                        guard isBundled else { return }
                        do {
                            if enabled {
                                try SMAppService.mainApp.register()
                            } else {
                                try SMAppService.mainApp.unregister()
                            }
                        } catch {
                            // roll the toggle back so the UI matches reality
                            launchAtLogin = SMAppService.mainApp.status == .enabled
                        }
                    }
            }
            Text(isBundled
                 ? "Registers with macOS login items."
                 : "Available when running as the bundled app (scripts/bundle.sh).")
                .font(.caption2).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Open dashboard")
                Spacer()
                Button("Open TUI") { OpenTUI.launch() }
            }
        }
        .padding(20)
        .onAppear {
            if isBundled { launchAtLogin = SMAppService.mainApp.status == .enabled }
        }
    }
}

private struct ThresholdsPane: View {
    @AppStorage(AppConfig.warningKey) private var warning = 70.0
    @AppStorage(AppConfig.criticalKey) private var critical = 90.0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Thresholds & notifications").font(.title2.weight(.semibold))
            Text("A crossing notifies once and re-arms below the line. Ranking, rails, and notifications share these values.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Warning at")
                Slider(value: $warning, in: 50...85, step: 5).frame(maxWidth: 220)
                Text("\(Int(warning))% used").monospacedDigit().frame(width: 76, alignment: .trailing)
            }
            HStack {
                Text("Critical at")
                Slider(value: $critical, in: 70...99, step: 1).frame(maxWidth: 220)
                Text("\(Int(critical))% used").monospacedDigit().frame(width: 76, alignment: .trailing)
            }
            if critical <= warning {
                Text("Critical is clamped above warning.").font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(20)
        .onChange(of: warning) { _ in apply() }
        .onChange(of: critical) { _ in apply() }
    }

    private func apply() {
        AppConfig.applyThresholds()
        NotificationCenter.default.post(name: .llmtallyDescriptorsChanged, object: nil)
    }
}

private struct RefreshPane: View {
    @AppStorage(AppConfig.cadenceKey) private var cadence = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Refresh").font(.title2.weight(.semibold))
            Text("One process-wide timer; per-source backoff stays with core. A 429 keeps last-good and locks the button.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Cadence")
                Spacer()
                Picker("", selection: $cadence) {
                    Text("5 min").tag(5)
                    Text("15 min").tag(15)
                    Text("30 min").tag(30)
                }
                .pickerStyle(.segmented).frame(width: 220)
            }
            Text("Manual refresh (popover) respects the vendor throttle.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(20)
        .onChange(of: cadence) { _ in
            NotificationCenter.default.post(name: .llmtallyConfigChanged, object: nil)
        }
    }
}

private struct CostPane: View {
    @AppStorage(AppConfig.costModeKey) private var costMode = "actual"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Cost").font(.title2.weight(.semibold))
            Text("Actual and Nominal are never shown side by side. NULL is not zero.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Mode")
                Spacer()
                Picker("", selection: $costMode) {
                    Text("Actual").tag("actual")
                    Text("Nominal").tag("nominal")
                }
                .pickerStyle(.segmented).frame(width: 220)
            }
            Text("Nominal = API list price equivalent. Subscription usage is not billed at this amount.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(20)
    }
}

/// Overview row order + visibility. Only the popover list is affected;
/// the status item's descriptors are the Builder's, untouched.
private struct OverviewRowsPane: View {
    @State private var order: [String] = OverviewRowsPane.effectiveOrder()
    @State private var hidden = HiddenAgents.all()
    @State private var manual = ProviderOrder.saved() != nil
    @State private var draggedAgent: String?

    private static func effectiveOrder() -> [String] {
        var agents = ProviderOrder.saved() ?? AGENT_DISPLAY_NAMES.keys.sorted()
        // catalog growth: agents unknown to a saved order append at the end
        for agent in AGENT_DISPLAY_NAMES.keys.sorted() where !agents.contains(agent) {
            agents.append(agent)
        }
        return agents.filter { AGENT_DISPLAY_NAMES.keys.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Overview").font(.title2.weight(.semibold))
            Text("Row order and visibility for the popover's Overview list. Without a manual order, rows rank by attention.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            ForEach(Array(order.enumerated()), id: \.element) { index, agent in
                HStack(spacing: 8) {
                    Image(systemName: "line.3.horizontal")
                        .font(.caption).foregroundStyle(.tertiary)
                    Button("↑") { move(index, by: -1) }.disabled(index == 0)
                    Button("↓") { move(index, by: 1) }.disabled(index == order.count - 1)
                    Text(agentDisplayName(agent))
                        .foregroundStyle(hidden.contains(agent) ? .secondary : .primary)
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { !hidden.contains(agent) },
                        set: { visible in
                            if visible { hidden.remove(agent) } else { hidden.insert(agent) }
                            HiddenAgents.set(hidden)
                        }))
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .opacity(draggedAgent == agent ? 0.4 : 1)
                .onDrag {
                    draggedAgent = agent
                    return NSItemProvider(object: agent as NSString)
                }
                .onDrop(of: [.text], delegate: DragReorderDelegate(
                    itemId: agent, draggedId: $draggedAgent,
                    indexOf: { id in order.firstIndex(of: id) },
                    move: { from, to in
                        order.moveElement(from: from, to: to)
                        ProviderOrder.set(order)
                        manual = true
                    }))
            }
            Divider()
            HStack {
                Text(manual ? "Manual order active" : "Attention order (default)")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Use attention order") {
                    ProviderOrder.set(nil)
                    manual = false
                    order = Self.effectiveOrder()
                }
                .disabled(!manual)
            }
        }
        .padding(20)
    }

    private func move(_ index: Int, by offset: Int) {
        let target = index + offset
        guard target >= 0 && target < order.count else { return }
        order.swapAt(index, target)
        ProviderOrder.set(order)
        manual = true
    }
}

private struct AccountsPane: View {
    @State private var quota: [QuotaSnapshotDTO] = []
    @State private var active: [String: String?] = [:]
    @State private var confirmDetach = false
    @State private var detachResult: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Accounts").font(.title2.weight(.semibold))
            Text("Switching lives in the popover. This page is guidance and the one destructive action.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(quota.enumerated()), id: \.offset) { _, snapshot in
                        HStack {
                            Text("\(agentDisplayName(snapshot.agent)) · \(snapshot.account ?? snapshot.accountId ?? "?")")
                                .font(.caption).lineLimit(1)
                            Spacer()
                            if snapshot.accountId != nil,
                               snapshot.accountId == (active[snapshot.agent] ?? nil) {
                                Text("active").font(.caption2).foregroundStyle(.green)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .frame(maxHeight: 180)
            Divider()
            HStack {
                Text("Codex detach")
                Spacer()
                Button("Detach…") { confirmDetach = true }
            }
            Text("Deletes ~/.codex/auth.json only after the vault copy matches live bytes; a mismatch aborts.")
                .font(.caption2).foregroundStyle(.secondary)
            if let detachResult {
                Text(detachResult).font(.caption2).foregroundStyle(.orange)
            }
            Divider()
            HStack {
                Text("Add login")
                Spacer()
                Button("Open TUI to add a login") { OpenTUI.launch() }
            }
        }
        .padding(20)
        .onAppear(perform: load)
        .alert("Detach the Codex login?", isPresented: $confirmDetach) {
            Button("Detach", role: .destructive) { detach() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Leaving the file in place would revoke the first account the moment a second one logs in.")
        }
    }

    private func load() {
        SidecarClient.shared.requestDecodable("quota", params: ["refresh": false], as: [QuotaSnapshotDTO].self) { result in
            DispatchQueue.main.async { if case .success(let value) = result { quota = value } }
        }
        SidecarClient.shared.requestDecodable("activeAccounts", as: [String: String?].self) { result in
            DispatchQueue.main.async { if case .success(let value) = result { active = value } }
        }
    }

    private func detach() {
        SidecarClient.shared.request("detachCodex") { result in
            DispatchQueue.main.async {
                switch result {
                case .success: detachResult = "Detached. The vault kept a verified capture."
                case .failure(let error): detachResult = error.localizedDescription
                }
            }
        }
    }
}

private struct AppearancePane: View {
    @AppStorage(Theme.storageKey) private var themeId = "system"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Appearance").font(.title2.weight(.semibold))
            Text("The six most-used editor palettes (design tokens v1.1.0). Meaning channels never depend on color alone.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            ForEach(Theme.presets, id: \.id) { theme in
                Button {
                    themeId = theme.id
                    NotificationCenter.default.post(name: .llmtallyDescriptorsChanged, object: nil)
                } label: {
                    HStack {
                        Image(systemName: themeId == theme.id ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(themeId == theme.id ? theme.accent : .secondary)
                        Text(theme.name)
                        Spacer()
                        HStack(spacing: 4) {
                            Circle().fill(theme.live).frame(width: 10, height: 10)
                            Circle().fill(theme.warn).frame(width: 10, height: 10)
                            Circle().fill(theme.crit).frame(width: 10, height: 10)
                            Circle().fill(theme.accent).frame(width: 10, height: 10)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, 3)
            }
        }
        .padding(20)
    }
}

private struct PrivacyPane: View {
    @AppStorage(PrivacySetting.key) private var privacyMode = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Privacy").font(.title2.weight(.semibold))
            Text("Prompts never leave this machine. This toggle neutralizes identity for screen sharing — the same policy in the status item, popover, tooltips, VoiceOver, and notifications.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Privacy mode")
                Spacer()
                Toggle("", isOn: $privacyMode)
                    .onChange(of: privacyMode) { _ in
                        NotificationCenter.default.post(name: .llmtallyPrivacyChanged, object: nil)
                    }
            }
            HStack {
                Text("Hides")
                Spacer()
                Text("provider names · accounts · costs").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text("Replaces with")
                Spacer()
                Text("P1 · Account hidden · Private metric hidden").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(20)
    }
}

/// Investigate happens in the TUI. The popover hands off instead of
/// growing a second terminal (01_plan §2).
enum OpenTUI {
    static func launch() {
        let script = """
        tell application "Terminal"
            activate
            do script "llmtally"
        end tell
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }
}
