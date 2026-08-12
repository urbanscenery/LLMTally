import SwiftUI
import LLMTallyKit

/// The popover (03_design_spec §3–§5): Overview with attention headline,
/// agent rows, Today cards — and Provider detail with per-account
/// windows and the Switch confirmation sheet.
struct OverviewView: View {
    @StateObject private var model = OverviewModel()
    @State private var selectedAgent: String?
    @State private var switchIntent: SwitchIntent?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 400, height: 560)
        .onAppear { model.load(refresh: true) }
        .sheet(item: $switchIntent) { intent in
            SwitchSheet(intent: intent, model: model) { switchIntent = nil }
        }
    }

    private var header: some View {
        HStack {
            if let agent = selectedAgent {
                Button {
                    selectedAgent = nil
                } label: {
                    Label(agentDisplayName(agent), systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .font(.headline)
            } else {
                Text("LLMTally").font(.headline)
            }
            Spacer()
            if let error = model.loadError {
                Text(error).font(.caption2).foregroundStyle(.red).lineLimit(1)
            }
            Button {
                SettingsWindowController.shared.show()
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.plain)
            .help("Settings (Builder lives there)")
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
    }

    @ViewBuilder
    private var content: some View {
        if let agent = selectedAgent {
            ProviderDetailView(
                agent: agent,
                items: model.agentGroups().first(where: { $0.agent == agent })?.items ?? [],
                activeAccountId: model.activeAccounts[agent] ?? nil,
                onSwitch: { snapshot in
                    guard let accountId = snapshot.accountId else { return }
                    switchIntent = SwitchIntent(
                        agent: agent,
                        selector: accountId,
                        label: snapshot.account ?? accountId)
                })
        } else if model.overview == nil {
            VStack(spacing: 8) {
                if model.loading {
                    ProgressView()
                    Text("Reading local ledger…").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("No data yet").font(.callout)
                    Text("Run an agent once, or open the TUI to scan.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            overviewList
        }
    }

    private var overviewList: some View {
        ScrollView {
            VStack(spacing: 0) {
                if let headline = model.headline() {
                    HeadlineView(item: headline)
                        .contentShape(Rectangle())
                        .onTapGesture { selectedAgent = headline.snapshot.agent }
                    Divider()
                }
                ForEach(model.agentGroups(), id: \.agent) { group in
                    if let row = model.overviewRow(for: group) {
                        AgentRow(item: row)
                            .contentShape(Rectangle())
                            .onTapGesture { selectedAgent = group.agent }
                        Divider().padding(.leading, 44)
                    }
                }
                TodaySection(bucket: model.todayBucket(), totals: model.overview?.report.totals)
            }
        }
    }

    private var footer: some View {
        HStack {
            if let loaded = model.lastLoadedAt {
                Text("Updated \(shortDuration(Date().timeIntervalSince(loaded))) ago · local ledger")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Open TUI") { OpenTUI.launch() }
                .font(.caption)
            Button(model.loading ? "Refreshing…" : "Refresh") {
                model.load(refresh: true)
            }
            .disabled(model.loading)
            .font(.caption)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
    }
}

struct SwitchIntent: Identifiable {
    let agent: String
    let selector: String
    let label: String
    var id: String { "\(agent):\(selector)" }
}

// MARK: - Headline

struct HeadlineView: View {
    let item: AgentAttention

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(kicker)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(accent)
            Text("\(agentDisplayName(item.snapshot.agent)) · \(item.snapshot.account ?? "unknown")")
                .font(.subheadline.weight(.semibold))
            Text(reason).font(.callout)
            Text(meta).font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(accent).frame(width: 3).padding(.vertical, 10)
        }
    }

    private var kicker: String { item.rank == .quiet ? "All clear" : "Needs attention" }

    private var accent: Color {
        switch item.rank {
        case .authInvalid, .critical: return .red
        case .rateLimited, .stale, .warning, .resetSoon: return .orange
        case .quiet: return .green
        }
    }

    private var reason: String {
        switch item.rank {
        case .authInvalid: return "Live quota failed · auth"
        case .rateLimited: return "Rate limited · retry \(retryIn)"
        case .stale: return "Stale · \(shortAge(sinceEpoch: item.snapshot.observedAtUtc))"
        case .critical, .warning, .resetSoon, .quiet:
            guard let window = item.topWindow else { return "no windows reported" }
            return "\(window.id) used \(Int(window.usedPercent.rounded()))%"
        }
    }

    private var meta: String {
        switch item.rank {
        case .authInvalid:
            if let window = item.topWindow {
                return "last-good \(Int(window.usedPercent.rounded()))% · \(shortAge(sinceEpoch: item.snapshot.observedAtUtc)) ago"
            }
            return "reconnect in Settings"
        case .rateLimited:
            if let window = item.topWindow {
                return "last-good \(window.id) \(Int(window.usedPercent.rounded()))% · not fresh"
            }
            return "last-good kept · not fresh"
        case .stale:
            return "from local logs, not live"
        case .critical, .warning, .resetSoon, .quiet:
            return resetText(item.topWindow?.resetsAtUtc)
        }
    }

    private var retryIn: String {
        guard let seconds = item.snapshot.retryAfterSeconds else { return "soon" }
        return shortDuration(seconds)
    }
}

// MARK: - Agent rows

struct AgentRow: View {
    let item: AgentAttention

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                ProviderStamp(agent: item.snapshot.agent)
                VStack(alignment: .leading, spacing: 0) {
                    Text(agentDisplayName(item.snapshot.agent)).font(.callout.weight(.medium))
                    if let account = item.snapshot.account {
                        Text(account).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                Text(bigValue).font(.callout).monospacedDigit()
                StatusChip(item: item)
            }
            if item.snapshot.windows.isEmpty {
                Text("no windows reported").font(.caption2).foregroundStyle(.secondary)
                    .padding(.leading, 32)
            } else {
                HStack(spacing: 10) {
                    ForEach(item.snapshot.windows.prefix(3)) { window in
                        WindowRail(window: window)
                    }
                    if item.snapshot.windows.count > 3 {
                        Text("+\(item.snapshot.windows.count - 3)")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 32)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var bigValue: String {
        guard let window = item.topWindow else { return "—" }
        if item.rank == .authInvalid { return "—" }
        return "\(Int(window.usedPercent.rounded()))%"
    }
}

struct StatusChip: View {
    let item: AgentAttention

    var body: some View {
        Text(label)
            .font(.caption2)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.16)))
            .foregroundStyle(color)
    }

    private var label: String {
        if let failure = item.snapshot.failure {
            switch failure.kind {
            case "auth_invalid": return "auth"
            case "rate_limited": return "429"
            default: return failure.kind
            }
        }
        if item.rank == .stale { return "stale" }
        return item.snapshot.source == "vendor_api" ? "live" : "stored"
    }

    private var color: Color {
        if item.snapshot.failure?.kind == "auth_invalid" { return .red }
        if item.snapshot.failure != nil || item.rank == .stale { return .orange }
        return item.snapshot.source == "vendor_api" ? .green : .secondary
    }
}

struct WindowRail: View {
    let window: QuotaWindowDTO

    var body: some View {
        HStack(spacing: 5) {
            Text(shortLabel).font(.caption2).foregroundStyle(.secondary)
                .frame(minWidth: 20, alignment: .leading)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(fillColor)
                        .frame(width: max(0, geometry.size.width * window.usedPercent / 100))
                }
            }
            .frame(height: 4)
        }
        .help("\(window.id) used \(Int(window.usedPercent.rounded()))% · \(resetText(window.resetsAtUtc))")
    }

    private var shortLabel: String {
        let id = window.id
        if id.contains("five_hour") || id.contains("300m") { return "5h" }
        if id.contains("seven_day") || id.contains("10080m") || id.hasPrefix("7d") { return "7d" }
        if id.lowercased().contains("fable") { return "Fable" }
        if id.contains("1month") { return "1mo" }
        return String(id.prefix(6))
    }

    private var fillColor: Color {
        if window.usedPercent >= CRITICAL_USED_PERCENT { return .red }
        if window.usedPercent >= WARNING_USED_PERCENT { return .orange }
        return .green
    }
}

// MARK: - Today

struct TodaySection: View {
    let bucket: ReportBucketDTO?
    let totals: ReportBucketDTO?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("TODAY · ACTUAL").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                card("Prompts", bucket.map { "\($0.rowCount)" } ?? "0", nil)
                card("Tokens", bucket.map { formatTokens($0.tokens.inputTokens + $0.tokens.outputTokens) } ?? "0", "in + out")
                card("Actual", actualText, actualNote)
            }
        }
        .padding(12)
    }

    private var actualText: String {
        guard let bucket else { return "—" }
        if let usd = bucket.actual.usd { return formatUsd(usd) }
        if bucket.actual.pricedRows > 0 { return formatUsd(bucket.actual.pricedSubtotalUsd) }
        return "—"
    }

    private var actualNote: String? {
        guard let bucket else { return nil }
        if bucket.actual.usd != nil { return "billable" }
        if bucket.actual.pricedRows > 0 { return "partial · \(bucket.actual.unpricedRows) unpriced" }
        return "unavailable"
    }

    private func card(_ title: String, _ value: String, _ note: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased()).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
            Text(value).font(.callout.weight(.semibold)).monospacedDigit()
            if let note {
                Text(note).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }
}

// MARK: - Provider detail

struct ProviderDetailView: View {
    let agent: String
    let items: [AgentAttention]
    let activeAccountId: String?
    let onSwitch: (QuotaSnapshotDTO) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Switch is a function of this provider. Credentials are not edited here.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    accountSection(item)
                    Divider()
                }
            }
        }
    }

    @ViewBuilder
    private func accountSection(_ item: AgentAttention) -> some View {
        let snapshot = item.snapshot
        let isActive = snapshot.accountId != nil && snapshot.accountId == activeAccountId
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(snapshot.account ?? snapshot.accountId ?? "unknown account")
                    .font(.callout.weight(.medium)).lineLimit(1)
                Spacer()
                if isActive {
                    StatusChip(item: item)
                    Text("current").font(.caption2).foregroundStyle(.secondary)
                } else if SWITCHABLE_AGENTS.contains(agent) && snapshot.accountId != nil {
                    StatusChip(item: item)
                    Button("Switch") { onSwitch(snapshot) }
                        .font(.caption)
                } else {
                    StatusChip(item: item)
                }
            }
            if snapshot.windows.isEmpty {
                Text("no windows reported").font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(snapshot.windows) { window in
                    HStack {
                        Text(window.id).font(.caption).lineLimit(1)
                        Spacer()
                        Text(resetText(window.resetsAtUtc)).font(.caption2).foregroundStyle(.secondary)
                        Text("\(Int(window.usedPercent.rounded()))%")
                            .font(.caption).monospacedDigit()
                            .frame(minWidth: 34, alignment: .trailing)
                    }
                }
            }
            Text("observed \(shortAge(sinceEpoch: snapshot.observedAtUtc)) ago · \(snapshot.source)")
                .font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

// MARK: - Switch sheet

struct SwitchSheet: View {
    enum Phase: Equatable {
        case confirm
        case inFlight
        case done(String)
        case failed(String)
    }

    let intent: SwitchIntent
    @ObservedObject var model: OverviewModel
    let dismiss: () -> Void
    @State private var phase: Phase = .confirm

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Switch \(agentDisplayName(intent.agent)) to \(intent.label)?")
                .font(.headline)

            switch phase {
            case .confirm:
                Text("A running session keeps its old token until restarted. Warning, not a block.")
                    .font(.caption)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.15)))
                Text("The vault capture must match live bytes; an empty read aborts and rolls back.")
                    .font(.caption2).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel") { dismiss() }
                    Button("Switch") { run() }.keyboardShortcut(.defaultAction)
                }
            case .inFlight:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Switching — holding the lock, do not quit.").font(.caption)
                }
            case .done(let message):
                Text(message).font(.caption)
                Text("Past ledger rows were not reassigned.").font(.caption2).foregroundStyle(.secondary)
                HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
            case .failed(let message):
                Text(message)
                    .font(.caption)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.15)))
                Text("The transaction rolled back; the live login is unchanged.")
                    .font(.caption2).foregroundStyle(.secondary)
                HStack { Spacer(); Button("Close") { dismiss() } }
            }
        }
        .padding(16)
        .frame(width: 340)
        .interactiveDismissDisabled(phase == .inFlight)
    }

    private func run() {
        phase = .inFlight
        model.performSwitch(agent: intent.agent, selector: intent.selector) { result in
            switch result {
            case .success(let outcome):
                let warnings = outcome.warnings ?? []
                let pids = outcome.liveSessions ?? []
                var message = "Switched. Now following \(intent.label)."
                if !pids.isEmpty { message += " \(pids.count) running session(s) still hold the old token." }
                if !warnings.isEmpty { message += "\n" + warnings.joined(separator: "\n") }
                phase = .done(message)
            case .failure(let error):
                phase = .failed(error.localizedDescription)
            }
        }
    }
}
