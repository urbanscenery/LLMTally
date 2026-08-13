import SwiftUI
import LLMTallyKit

/// The popover (03_design_spec §3–§5): Overview with attention headline,
/// agent rows, Today cards — and Provider detail with per-account
/// windows and the Switch confirmation sheet.
struct OverviewView: View {
    @StateObject private var model = OverviewModel()
    @State private var selectedAgent: String?
    @State private var switchIntent: SwitchIntent?
    @State private var focusedRow: Int?
    @AppStorage(PrivacySetting.key) private var privacy = false
    @AppStorage(Theme.storageKey) private var themeId = "system"

    private var aliases: [String: String] {
        privacyAliases(for: model.overview?.quota ?? [])
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 400, height: 560)
        // reading themeId keeps every themed child live while the
        // panel stays open next to Settings
        .tint((Theme.presets.first { $0.id == themeId } ?? Theme.system).accent)
        .onAppear {
            model.load(refresh: true)
            if let target = PendingNavigation.consume() {
                selectedAgent = target
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .llmtallyKeyCommand)) { notification in
            handleKey(notification.object as? String ?? "")
        }
        .sheet(item: $switchIntent) { intent in
            SwitchSheet(intent: intent, model: model) { switchIntent = nil }
        }
    }

    /// §9 keyboard: Esc back/close, `s` first provider, ⌘R refresh,
    /// ↑↓/Enter row navigation.
    private func handleKey(_ command: String) {
        guard switchIntent == nil else { return }  // the sheet owns its keys
        switch command {
        case "esc":
            if selectedAgent != nil {
                selectedAgent = nil
            } else {
                NotificationCenter.default.post(name: .llmtallyClosePopover, object: nil)
            }
        case "s":
            if selectedAgent == nil {
                selectedAgent = model.agentGroups().first?.agent
            }
        case "refresh":
            if model.retryAfterSeconds == nil {
                model.load(refresh: true)
            }
        case "up", "down":
            guard selectedAgent == nil else { return }
            let count = model.agentGroups().count
            guard count > 0 else { return }
            let delta = command == "down" ? 1 : -1
            focusedRow = ((focusedRow ?? -delta) + delta + count) % count
        case "enter":
            if selectedAgent == nil, let focusedRow,
               focusedRow < model.agentGroups().count {
                selectedAgent = model.agentGroups()[focusedRow].agent
            }
        default:
            break
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
            } else if let quota = model.overview?.quota {
                FreshnessSummary(quota: quota)
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
                privacy: privacy,
                detail: model.providerDetails[agent],
                onSwitch: { snapshot in
                    guard let accountId = snapshot.accountId else { return }
                    switchIntent = SwitchIntent(
                        agent: agent,
                        selector: accountId,
                        label: privacy ? "the selected account" : (snapshot.account ?? accountId))
                })
                .onAppear { model.loadProviderDetail(agent: agent) }
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
                    // quiet = nothing needs attention — a plain one-liner,
                    // not a card that singles out one account
                    if headline.rank == .quiet {
                        AllClearLine()
                    } else {
                        HeadlineView(item: headline, privacy: privacy,
                                     alias: aliases[headline.snapshot.agent] ?? "P?")
                            .contentShape(Rectangle())
                            .onTapGesture { selectedAgent = headline.snapshot.agent }
                    }
                    Divider()
                }
                ForEach(Array(model.agentGroups().enumerated()), id: \.element.agent) { index, group in
                    if let row = model.overviewRow(for: group) {
                        AgentRow(item: row, privacy: privacy,
                                 alias: aliases[row.snapshot.agent] ?? "P?")
                            .background(focusedRow == index ? Color.primary.opacity(0.06) : .clear)
                            .contentShape(Rectangle())
                            .onTapGesture { selectedAgent = group.agent }
                        Divider().padding(.leading, 44)
                    }
                }
                TodaySection(bucket: model.todayBucket(),
                             totals: model.overview?.report.totals,
                             privacy: privacy)
                WeeklyChart(buckets: model.overview?.report.buckets ?? [],
                            privacy: privacy,
                            hourBuckets: model.hourBuckets)
            }
        }
    }

    private var footer: some View {
        HStack {
            if let loaded = model.lastLoadedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("Updated \(shortDuration(context.date.timeIntervalSince(loaded))) ago · local ledger")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Open TUI") { OpenTUI.launch() }
                .font(.caption)
            if let retry = model.retryAfterSeconds, retry > 0 {
                // 429: last-good stays, refresh locks behind the retry
                Button("Retry in \(shortDuration(retry))") {}
                    .disabled(true)
                    .font(.caption)
            } else {
                Button(model.loading ? "Refreshing…" : "Refresh") {
                    model.load(refresh: true)
                }
                .disabled(model.loading)
                .font(.caption)
            }
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

/// The quiet-state headline: one line, no account details.
struct AllClearLine: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.current().accent).frame(width: 6, height: 6)
            Text("All clear")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

struct HeadlineView: View {
    let item: AgentAttention
    var privacy = false
    var alias = "P?"

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(kicker)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(accent)
            Text(privacy
                 ? "\(alias) · Account hidden"
                 : "\(agentDisplayName(item.snapshot.agent)) · \(item.snapshot.account ?? "unknown")")
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
        let theme = Theme.current()
        switch item.rank {
        case .authInvalid, .critical: return theme.crit
        case .rateLimited, .stale, .warning, .resetSoon: return theme.warn
        case .quiet: return theme.accent
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
    var privacy = false
    var alias = "P?"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                if privacy {
                    PrivacyStamp(alias: alias)
                } else {
                    ProviderStamp(agent: item.snapshot.agent)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(privacy ? alias : agentDisplayName(item.snapshot.agent))
                        .font(.callout.weight(.medium))
                    if privacy {
                        Text("Account hidden").font(.caption2).foregroundStyle(.secondary)
                    } else if let account = item.snapshot.account {
                        Text(account).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
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
            // an intentionally skipped live fetch (budget/cadence/claim)
            // is normal operation: the user-facing word is "cached"
            case "deferred": return "cached"
            default: return failure.kind
            }
        }
        if item.rank == .stale { return "stale" }
        return item.snapshot.source == "vendor_api" ? "live" : "stored"
    }

    private var color: Color {
        let theme = Theme.current()
        if item.snapshot.failure?.kind == "auth_invalid" { return theme.crit }
        // cached is healthy — same accent as live, never a warning
        if item.snapshot.failure?.kind == "deferred" { return theme.accent }
        if item.snapshot.failure != nil || item.rank == .stale { return theme.warn }
        return item.snapshot.source == "vendor_api" ? theme.accent : .secondary
    }
}

struct WindowRail: View {
    let window: QuotaWindowDTO

    var body: some View {
        HStack(spacing: 5) {
            Text(shortWindowLabel(window.id)).font(.caption2).foregroundStyle(.secondary)
                .frame(minWidth: 20, alignment: .leading)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(railFill(window.usedPercent))
                        .frame(width: max(0, geometry.size.width * window.usedPercent / 100))
                }
            }
            .frame(height: 4)
            // every rail carries its own number — no single big value
            Text("\(Int(window.usedPercent.rounded()))%")
                .font(.system(size: 9)).monospacedDigit().foregroundStyle(.secondary)
                .frame(minWidth: 24, alignment: .trailing)
        }
        .help("\(window.id) used \(Int(window.usedPercent.rounded()))% · \(resetText(window.resetsAtUtc))")
    }
}

/// Healthy fill is the THEME ACCENT so a theme change is unmistakable;
/// warn/crit keep the theme's alarm colors.
func railFill(_ usedPercent: Double) -> Color {
    let theme = Theme.current()
    if usedPercent >= CRITICAL_USED_PERCENT { return theme.crit }
    if usedPercent >= WARNING_USED_PERCENT { return theme.warn }
    return theme.accent
}

// MARK: - Today

struct TodaySection: View {
    let bucket: ReportBucketDTO?
    let totals: ReportBucketDTO?
    var privacy = false
    @AppStorage(AppConfig.costModeKey) private var costMode = "actual"

    private var nominal: Bool { costMode == "nominal" }
    private var modeLabel: String { nominal ? "Nominal" : "Actual" }
    private var cost: CostResultDTO? {
        guard let bucket else { return nil }
        return nominal ? bucket.nominal : bucket.actual
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("TODAY · \(modeLabel.uppercased())")
                .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                card("Prompts", bucket.map { "\($0.rowCount)" } ?? "0", nil)
                card("Tokens", bucket.map { formatTokens($0.tokens.inputTokens + $0.tokens.outputTokens) } ?? "0", "in + out")
                card(modeLabel, costText, costNote)
            }
        }
        .padding(12)
    }

    private var costText: String {
        if privacy { return "hidden" }
        guard let cost else { return "—" }
        if let usd = cost.usd { return formatUsd(usd) }
        if cost.pricedRows > 0 { return formatUsd(cost.pricedSubtotalUsd) }
        return "—"
    }

    private var costNote: String? {
        if privacy { return "Private metric hidden" }
        guard let cost else { return nominal ? "list-price equivalent" : nil }
        if cost.usd != nil { return nominal ? "list-price equivalent" : "billable" }
        if cost.pricedRows > 0 { return "partial · \(cost.unpricedRows) unpriced" }
        return "unavailable"
    }

    private func card(_ title: String, _ value: String, _ note: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased()).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
            Text(value).font(.callout.weight(.semibold)).monospacedDigit()
            // the note line always occupies its row so all three cards
            // share one height regardless of which have a note
            Text(note ?? " ").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }
}

// MARK: - Header freshness

/// `Fresh · 42s` / `N stale` / `auth` — the header's one-line answer to
/// "can I trust these numbers" (§3 헤더).
struct FreshnessSummary: View {
    let quota: [QuotaSnapshotDTO]

    var body: some View {
        // ages must tick while the panel is open — elapsed time alone
        // never re-renders a SwiftUI view
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let (glyph, text, color) = summary(now: context.date)
            HStack(spacing: 4) {
                Text(glyph).font(.caption)
                Text(text).font(.caption2).monospacedDigit()
            }
            .foregroundStyle(color)
        }
    }

    private func summary(now: Date) -> (String, String, Color) {
        let theme = Theme.current()
        if quota.contains(where: { $0.failure?.kind == "auth_invalid" }) {
            return ("!", "auth", theme.crit)
        }
        let staleCount = quota.filter {
            $0.failure?.kind == "rate_limited"
                || ($0.source == "vendor_api"
                    && now.timeIntervalSince1970 - epochSeconds($0.observedAtUtc) > STALE_AFTER_SECONDS)
        }.count
        if staleCount > 0 {
            return ("◷", "\(staleCount) stale", theme.warn)
        }
        let newest = quota.map { epochSeconds($0.observedAtUtc) }.max()
        guard let newest else { return ("—", "no reading", .secondary) }
        return ("●", "Fresh · \(shortAge(sinceEpoch: newest, now: now))", theme.accent)
    }
}

// MARK: - Weekly chart

/// "This week" dual line (03_design_spec §3): tokens + Actual over the
/// last 7 real daily buckets. Each series normalizes to its own max —
/// never one shared axis. Fewer than 2 real buckets shows
/// `Not enough history` instead of inventing a trend.
struct WeeklyChart: View {
    let buckets: [ReportBucketDTO]
    var privacy = false
    /// Hour-grain buckets raise the line resolution (~168 points per
    /// week instead of 7); the day axis labels stay.
    var hourBuckets: [ReportBucketDTO] = []
    @AppStorage(AppConfig.costModeKey) private var costMode = "actual"
    @AppStorage(Theme.storageKey) private var themeId = "system"

    private var nominal: Bool { costMode == "nominal" }
    private var recent: [ReportBucketDTO] { Array(buckets.suffix(7)) }
    private var series: [ReportBucketDTO] {
        hourBuckets.count >= 8 ? Array(hourBuckets.suffix(168)) : recent
    }

    private func costOf(_ bucket: ReportBucketDTO) -> Double {
        let cost = nominal ? bucket.nominal : bucket.actual
        return cost?.usd ?? cost?.pricedSubtotalUsd ?? 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("THIS WEEK").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if recent.count >= 2 {
                    legendSwatch(color: Theme.current().accent, label: "tokens")
                    if !privacy {
                        legendSwatch(color: Theme.current().actual, label: nominal ? "Nominal" : "Actual")
                    }
                }
            }
            if recent.count < 2 {
                Text("Not enough history · snapshot only")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                GeometryReader { geometry in
                    let theme = Theme.current()
                    let tokens = series.map { $0.tokens.inputTokens + $0.tokens.outputTokens }
                    let prices = series.map { costOf($0) }
                    ZStack {
                        linePath(values: tokens, in: geometry.size)
                            .stroke(theme.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                        if !privacy {
                            linePath(values: prices, in: geometry.size)
                                .stroke(theme.actual, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                        }
                    }
                }
                .frame(height: 64)
                HStack {
                    ForEach(recent, id: \.key) { bucket in
                        Text(String(bucket.key.suffix(5)))
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
        .accessibilityLabel(accessibilityText)
    }

    private func legendSwatch(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 1).fill(color).frame(width: 10, height: 2)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    /// Each series against its own max — the two lines share a canvas,
    /// not an axis.
    private func linePath(values: [Double], in size: CGSize) -> Path {
        let maximum = max(values.max() ?? 1, 0.000_001)
        let count = values.count
        return Path { path in
            for (index, value) in values.enumerated() {
                let x = count == 1 ? 0 : CGFloat(index) / CGFloat(count - 1) * size.width
                let y = size.height - CGFloat(value / maximum) * (size.height - 4) - 2
                if index == 0 {
                    path.move(to: CGPoint(x: x, y: y))
                } else {
                    path.addLine(to: CGPoint(x: x, y: y))
                }
            }
        }
    }

    private var accessibilityText: String {
        guard recent.count >= 2, let last = recent.last else { return "Not enough history" }
        let tokens = formatTokens(last.tokens.inputTokens + last.tokens.outputTokens)
        return privacy
            ? "Weekly tokens, latest \(tokens). Cost hidden."
            : "Weekly tokens and actual cost, latest \(tokens)."
    }
}

// MARK: - Provider detail

struct ProviderDetailView: View {
    let agent: String
    let items: [AgentAttention]
    let activeAccountId: String?
    var privacy = false
    var detail: OverviewModel.ProviderDetailData?
    let onSwitch: (QuotaSnapshotDTO) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Switch is a function of this provider. Credentials are not edited here.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                // fixed, stable order like the TUI accounts tab — not
                // attention-sorted, so rows never jump between opens
                ForEach(Array(orderedItems.enumerated()), id: \.offset) { _, item in
                    accountSection(item)
                    Divider()
                }
                lowerHalf
            }
        }
    }

    /// Today cards, by-model table, weekly line, TUI handoff (§4).
    @ViewBuilder
    private var lowerHalf: some View {
        if let detail {
            TodaySection(bucket: detail.dayBuckets.first { $0.key == localDayKey() },
                         totals: nil, privacy: privacy)
            if !detail.modelBuckets.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("TODAY · BY MODEL")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 4) {
                        GridRow {
                            Text("Model").gridColumnAlignment(.leading)
                            Text("Prompts").gridColumnAlignment(.trailing)
                            Text("Tokens").gridColumnAlignment(.trailing)
                            Text("Actual").gridColumnAlignment(.trailing)
                        }
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        ForEach(detail.modelBuckets, id: \.key) { bucket in
                            GridRow {
                                Text(bucket.key).lineLimit(1)
                                Text("\(bucket.rowCount)")
                                Text(formatTokens(bucket.tokens.inputTokens + bucket.tokens.outputTokens))
                                Text(modelActual(bucket))
                            }
                            .font(.caption2).monospacedDigit()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
            WeeklyChart(buckets: detail.dayBuckets, privacy: privacy,
                        hourBuckets: detail.hourBuckets)
            HStack {
                Button("Open TUI · \(agentDisplayName(agent))") { OpenTUI.launch() }
                    .font(.caption)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        } else {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Loading ledger detail…").font(.caption2).foregroundStyle(.secondary)
            }
            .padding(12)
        }
    }

    private var orderedItems: [AgentAttention] {
        items.sorted {
            ($0.snapshot.account ?? $0.snapshot.accountId ?? "")
                < ($1.snapshot.account ?? $1.snapshot.accountId ?? "")
        }
    }

    private func modelActual(_ bucket: ReportBucketDTO) -> String {
        if privacy { return "hidden" }
        let cost = AppConfig.nominalMode ? bucket.nominal : .some(bucket.actual)
        guard let cost else { return "—" }
        if let usd = cost.usd { return formatUsd(usd) }
        if cost.pricedRows > 0 { return formatUsd(cost.pricedSubtotalUsd) }
        return "—"
    }

    @ViewBuilder
    private func accountSection(_ item: AgentAttention) -> some View {
        let snapshot = item.snapshot
        let isActive = snapshot.accountId != nil && snapshot.accountId == activeAccountId
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(privacy ? "Account hidden" : (snapshot.account ?? snapshot.accountId ?? "unknown account"))
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
                // horizontal bars, TUI-style: label · bar · percent,
                // native id + reset underneath
                ForEach(snapshot.windows) { window in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(shortWindowLabel(window.id))
                                .font(.caption).frame(width: 42, alignment: .leading)
                            GeometryReader { geometry in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color.primary.opacity(0.1))
                                    Capsule().fill(railFill(window.usedPercent))
                                        .frame(width: max(0, geometry.size.width * window.usedPercent / 100))
                                }
                            }
                            .frame(height: 6)
                            Text("\(Int(window.usedPercent.rounded()))%")
                                .font(.caption).monospacedDigit()
                                .frame(minWidth: 34, alignment: .trailing)
                        }
                        Text("\(window.id) · \(resetTextDetailed(window.resetsAtUtc))")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                            .padding(.leading, 48)
                    }
                    .padding(.vertical, 1)
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
