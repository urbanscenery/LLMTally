import SwiftUI
import LLMTallyKit

/// The popover (03_design_spec §3–§5): Overview with attention headline,
/// agent rows, Today cards — and Provider detail with per-account
/// windows and the Switch confirmation sheet.
/// Natural height of the popover's scrollable content — bubbles up from
/// whichever branch (overview list / provider detail) is on screen.
struct PanelContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

extension View {
    /// Applied to a ScrollView's inner stack: reports its laid-out
    /// height so the panel can fit the content.
    func reportsPanelContentHeight() -> some View {
        background(GeometryReader { proxy in
            Color.clear.preference(key: PanelContentHeightKey.self, value: proxy.size.height)
        })
    }
}

struct OverviewView: View {
    /// Header (40) + footer (34) + the two 1pt dividers.
    static let chromeHeight: CGFloat = 76

    // the shared app-lifetime model: reopening paints last-good data
    // immediately, the refresh lands behind it
    @ObservedObject private var model = OverviewModel.shared
    @ObservedObject private var bell = NotificationCenterModel.shared
    @State private var selectedAgent: String?
    @State private var switchIntent: SwitchIntent?
    @State private var focusedRow: Int?
    @State private var showNotifications = false
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
        // keep in lockstep with StatusItemController.panelWidth
        .frame(width: 330)
        // content-fit panel: the scroll content reports its natural
        // height; the controller sizes the panel to it (clamped to the
        // screen), so scrolling only starts past the screen's work area
        .onPreferenceChange(PanelContentHeightKey.self) { contentHeight in
            guard contentHeight > 0 else { return }
            NotificationCenter.default.post(
                name: .llmtallyPanelDesiredHeight, object: nil,
                userInfo: ["height": contentHeight + Self.chromeHeight])
        }
        // reading themeId keeps every themed child live while the
        // panel stays open next to Settings
        .tint(Theme.resolve(themeId).accent)
        .onAppear {
            model.loadOnAppear()
            // a day drill-down is a transient inspection, not a mode —
            // reopening the panel starts from the plain overview
            model.selectDay(nil)
            model.providerSelectedDay = nil
            if let target = PendingNavigation.consume() {
                selectedAgent = target
            }
        }
        // the selection belongs to one provider's chart — entering,
        // leaving, or changing providers must not carry it along
        .onChange(of: selectedAgent) { _ in
            model.providerSelectedDay = nil
        }
        .onReceive(NotificationCenter.default.publisher(for: .llmtallyKeyCommand)) { notification in
            handleKey(notification.object as? String ?? "")
        }
        // usage only moves with data: re-read the stored state (no
        // refresh budget) so the background cadence's fetches land in
        // the open panel and its provider detail
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { _ in
            model.load(refresh: false)
            if let agent = selectedAgent {
                model.loadProviderDetail(agent: agent)
            }
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
            if showNotifications {
                closeNotifications()
            } else if selectedAgent != nil {
                // innermost first: close the day drill-down, then leave
                // the provider page
                if model.providerSelectedDay != nil {
                    model.providerSelectedDay = nil
                } else {
                    selectedAgent = nil
                }
            } else if model.selectedDay != nil {
                model.selectDay(nil)
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
            if showNotifications {
                Button {
                    closeNotifications()
                } label: {
                    Label("Notifications", systemImage: "chevron.left")
                }
                .buttonStyle(HoverActionButtonStyle())
                .font(.headline)
            } else if let agent = selectedAgent {
                Button {
                    selectedAgent = nil
                } label: {
                    Label(privacy ? (aliases[agent] ?? "P?") : agentDisplayName(agent),
                          systemImage: "chevron.left")
                }
                .buttonStyle(HoverActionButtonStyle())
                .font(.headline)
            } else {
                Text("LLMTally").font(.headline)
            }
            Spacer()
            if showNotifications {
                if bell.hasDismissable {
                    Button("Clear all") { bell.clearAll() }
                        .buttonStyle(HoverActionButtonStyle())
                        .font(.caption)
                }
            } else if model.loadError != nil {
                // the header stays one line; the full error wraps in the
                // banner below — a truncated error is exactly the part
                // the user needed
                Text("load error").font(.caption2).foregroundStyle(.red)
            } else if let quota = model.overview?.quota {
                FreshnessSummary(quota: quota)
            }
            NotificationBellButton(center: bell, isOpen: showNotifications) {
                if showNotifications {
                    closeNotifications()
                } else {
                    showNotifications = true
                }
            }
            Button {
                SettingsWindowController.shared.show()
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(HoverActionButtonStyle())
            .help("Settings (Builder lives there)")
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
    }

    /// Leaving the panel is what reads the rows (the badge went out the
    /// moment it opened) — the 시안's GitHub/Slack convention.
    private func closeNotifications() {
        bell.markAllRead()
        showNotifications = false
    }

    @ViewBuilder
    private var content: some View {
        if showNotifications {
            NotificationCenterView(center: bell, privacy: privacy) { agent in
                closeNotifications()
                selectedAgent = agent
            }
        } else if let agent = selectedAgent {
            ProviderDetailView(
                agent: agent,
                items: model.agentGroups().first(where: { $0.agent == agent })?.items ?? [],
                activeAccountId: model.activeAccounts[agent] ?? nil,
                privacy: privacy,
                detail: model.providerDetails[agent],
                switchCooldownUntil: model.switchCooldownUntil,
                selectedDay: model.providerSelectedDay,
                dayModels: model.providerSelectedDay.flatMap {
                    model.providerDayModels["\(agent)|\($0)"]
                },
                onSelectDay: { model.selectProviderDay(agent: agent, $0) },
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
                } else if let error = model.loadError {
                    errorBanner(error)
                } else {
                    Text("No data yet").font(.callout)
                    Text("Run an agent once — the menu bar collects automatically.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            overviewList
        }
    }

    /// Full-width, fully wrapped error text — never a one-line ellipsis:
    /// the tail of a load error is the part that says what to fix.
    private func errorBanner(_ error: String) -> some View {
        // raw errors can carry account ids/paths (audit C1-11)
        Text(privacy ? "error (details hidden)" : error)
            .font(.caption2).foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Color.red.opacity(0.08))
    }

    private var overviewList: some View {
        ScrollView {
            VStack(spacing: 0) {
                // inside the measured stack so the panel grows to fit the
                // wrapped error instead of squeezing it into one line
                if let error = model.loadError {
                    errorBanner(error)
                    Divider()
                }
                if let headline = model.headline() {
                    // the headline card is act-now territory only (auth,
                    // mismatch, critical) — notice-tier states (warning,
                    // reset-soon, stale, rate-limited) went to the bell
                    // (06_notification_center_design §3), so their
                    // moment here is the plain all-clear line
                    if isActNowRank(headline.rank) {
                        HeadlineView(item: headline, privacy: privacy,
                                     alias: aliases[headline.snapshot.agent] ?? "P?")
                            .contentShape(Rectangle())
                            .hoverHighlight()
                            .onTapGesture { selectedAgent = headline.snapshot.agent }
                    } else {
                        AllClearLine(noticesInBell: headline.rank != .quiet)
                    }
                    Divider()
                }
                ForEach(Array(model.agentGroups().enumerated()), id: \.element.agent) { index, group in
                    if let row = model.overviewRow(for: group) {
                        AgentRow(item: row, privacy: privacy,
                                 alias: aliases[row.snapshot.agent] ?? "P?")
                            .background(focusedRow == index ? Color.primary.opacity(0.06) : .clear)
                            .contentShape(Rectangle())
                            .hoverHighlight()
                            .onTapGesture { selectedAgent = group.agent }
                        Divider().padding(.leading, 44)
                    }
                }
                TodaySection(bucket: model.todayBucket(),
                             totals: model.overview?.report.totals,
                             privacy: privacy)
                WeeklyChart(buckets: model.overview?.report.buckets ?? [],
                            privacy: privacy,
                            hourBuckets: model.hourBuckets,
                            selectedDay: model.selectedDay,
                            onSelectDay: { model.selectDay($0) })
                if let day = model.selectedDay {
                    // a zero-filled chart day has no report bucket —
                    // selecting it still opens, honestly empty
                    let bucket = model.overview?.report.buckets.first { $0.key == day }
                        ?? emptyDayBucket(key: day)
                    Divider()
                    DayDetailSection(bucket: bucket,
                                     report: model.dayReports[day],
                                     privacy: privacy,
                                     onClose: { model.selectDay(nil) })
                }
            }
            .reportsPanelContentHeight()
        }
    }

    private var footer: some View {
        HStack {
            if let loaded = model.lastLoadedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    // three buttons plus "Retry in 1m 30s" can crowd the
                    // 330pt row — the timestamp yields, the buttons never do
                    Text("Updated \(shortDuration(context.date.timeIntervalSince(loaded))) ago · local ledger")
                        .font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer()
            // the only in-panel way out of a menubar-only app (no main
            // menu, so ⌘Q needs the key monitor; see StatusItemController)
            Button("Quit") { QuitController.requestQuit() }
                .buttonStyle(HoverActionButtonStyle())
                .font(.caption)
                .help("Quit LLMTally (⌘Q)")
            Button("Open TUI") { OpenTUI.launch() }
                .buttonStyle(HoverActionButtonStyle())
                .font(.caption)
            if let retry = model.retryAfterSeconds, retry > 0 {
                // 429: last-good stays, refresh locks behind the retry
                Button("Retry in \(shortDuration(retry))") {}
                    .buttonStyle(HoverActionButtonStyle())
                    .disabled(true)
                    .font(.caption)
            } else {
                Button(model.loading ? "Refreshing…" : "Refresh") {
                    model.load(refresh: true)
                }
                .buttonStyle(HoverActionButtonStyle())
                .disabled(model.loading)
                .font(.caption)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
    }
}

/// Theme-accent border on hover — the popover's "this is clickable"
/// affordance for row-shaped targets (buttons keep their own styles).
private struct HoverHighlight: ViewModifier {
    @State private var hovering = false
    @AppStorage(Theme.storageKey) private var themeId = "system"

    func body(content: Content) -> some View {
        let theme = Theme.resolve(themeId)
        content
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(hovering ? theme.accent : .clear, lineWidth: 1.5)
                    .padding(1))
            .onHover { hovering = $0 }
    }
}

extension View {
    func hoverHighlight() -> some View { modifier(HoverHighlight()) }
}

/// Every popover button wears this: a quiet chip at rest so it reads
/// as clickable, and the theme accent (tint + border) on hover.
struct HoverActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        StyleBody(configuration: configuration)
    }

    // ButtonStyle itself cannot hold @State — the hover flag lives in
    // a nested view
    private struct StyleBody: View {
        let configuration: Configuration
        @State private var hovering = false
        @Environment(\.isEnabled) private var isEnabled
        @AppStorage(Theme.storageKey) private var themeId = "system"

        var body: some View {
            let theme = Theme.resolve(themeId)
            let active = hovering && isEnabled
            configuration.label
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .foregroundStyle(active ? theme.accent : Color.primary)
                .background(RoundedRectangle(cornerRadius: 5)
                    .fill(active ? theme.accent.opacity(0.16) : Color.primary.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 5)
                    .stroke(active ? theme.accent : Color.clear, lineWidth: 1))
                .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.4)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
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
    /// True when notice-tier states exist but were routed to the bell —
    /// the line stays honest: nothing needs ACTION, notices are waiting.
    var noticesInBell = false

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.current().accent).frame(width: 6, height: 6)
            Text("All clear")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            if noticesInBell {
                Text("· notices in the bell")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
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
        case .accountMismatch, .rateLimited, .stale, .warning, .resetSoon: return theme.warn
        case .quiet: return theme.accent
        }
    }

    private var reason: String {
        switch item.rank {
        case .authInvalid: return "Live quota failed · auth"
        case .accountMismatch: return "Account mismatch · switch reverted"
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
        case .accountMismatch:
            if let owner = item.snapshot.failure?.credentialOwner {
                return "live login: \(owner.account ?? owner.accountId ?? "another account")"
            }
            return "quit the running session, then switch again"
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
                // one full-width rail per line: rows read the same
                // whether a provider reports one window or four
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(item.snapshot.windows) { window in
                        WindowRail(window: window)
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
            case "account_mismatch": return "mismatch"
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

/// Rail label: compact like the menu bar's, but model-scoped windows
/// keep their model — Claude's `7d Fable` must not collapse into `7d`.
func railWindowLabel(_ id: String) -> String {
    if id == "seven_day_opus" { return "7d Opus" }
    if id.hasPrefix("7d "), id.count > 3 { return id }
    return shortWindowLabel(id)
}

/// Fixed label column so every rail starts at the same x regardless of
/// label length; anything longer than the column ellipsizes.
let railLabelWidth: CGFloat = 48

struct WindowRail: View {
    let window: QuotaWindowDTO

    var body: some View {
        HStack(spacing: 5) {
            Text(railWindowLabel(window.id)).font(.caption2).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
                .frame(width: railLabelWidth, alignment: .leading)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("TODAY")
                .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            // quota cost is the one default cost card — a permanent empty
            // Spend card on a subscription-only ledger would re-create
            // the old two-card confusion; spend earns its slot only
            // when the day billed real money (never summed with quota cost)
            HStack(spacing: 8) {
                card("Prompts", bucket.map { "\($0.promptCount)" } ?? "0", nil)
                card("Tokens", bucket.map { formatTokens($0.tokens.inputTokens + $0.tokens.outputTokens) } ?? "0", "in + out")
                card("Quota cost", costText(bucket?.quotaCost, quota: true), quotaNote)
                if hasSpend {
                    card("Spend cost", costText(bucket?.spendCost, quota: false), spendNote)
                }
            }
        }
        .padding(12)
    }

    private var hasSpend: Bool {
        guard let spend = bucket?.spendCost else { return false }
        return spend.pricedRows > 0 || spend.unpricedRows > 0
    }

    private func costText(_ cost: CostResultDTO?, quota: Bool) -> String {
        if privacy { return "hidden" }
        return formatCost(cost, quota: quota)
    }

    // four cards leave ~54pt per note — keep them one short word
    private var spendNote: String? {
        if privacy { return "hidden" }
        guard let cost = bucket?.spendCost else { return nil }
        if cost.usd != nil { return "billed" }
        if cost.pricedRows > 0 { return "partial" }
        return "no billed"
    }

    private var quotaNote: String? {
        privacy ? "hidden" : "list-price"
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
        if quota.contains(where: { $0.failure?.kind == "account_mismatch" }) {
            return ("!", "mismatch", theme.warn)
        }
        let agedSources: Set<String> = ["vendor_api", "stored_history", "third_party_cache"]
        let staleCount = quota.filter {
            $0.failure?.kind == "rate_limited"
                || (agedSources.contains($0.source)
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

/// "This week" lines (03_design_spec §3): tokens + quota cost (+ spend when
/// the week billed real money) over the last 7 calendar days, gaps
/// zero-filled (no usage IS zero). Tokens normalize to their own max;
/// the cost lines share one dollar scale. An empty ledger shows
/// `Not enough history` instead of a flat invented week.
struct WeeklyChart: View {
    let buckets: [ReportBucketDTO]
    var privacy = false
    /// Hour-grain buckets raise the line resolution (~168 points per
    /// week instead of 7); the day axis labels stay.
    var hourBuckets: [ReportBucketDTO] = []
    /// Day drill-down (main Overview only): the selected day is
    /// column-highlighted and clicking a column selects/toggles it.
    var selectedDay: String? = nil
    var onSelectDay: ((String) -> Void)? = nil
    @AppStorage(Theme.storageKey) private var themeId = "system"
    // legend clicks toggle lines; remembered, shared by both charts
    @AppStorage(AppConfig.weeklyShowTokensKey) private var showTokens = true
    @AppStorage(AppConfig.weeklyShowSpendKey) private var showSpend = true
    @AppStorage(AppConfig.weeklyShowQuotaKey) private var showQuota = true

    /// The last 7 real calendar days, zero-filled. Day buckets only
    /// exist for days with rows, so a sparse agent's `suffix(7)` was
    /// weeks of scattered days posing as "this week" — a day without
    /// usage is a zero, not a day to skip.
    private var recent: [ReportBucketDTO] {
        let byKey = Dictionary(buckets.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        return (0..<7).reversed().map { offset in
            let date = Calendar.current.date(byAdding: .day, value: -offset, to: Date()) ?? Date()
            let key = localDayKey(date)
            return byKey[key] ?? emptyDayBucket(key: key)
        }
    }

    /// Hour-grain series, zero-filled over the same week for the same
    /// reason: the line's x axis is index-based, so skipped quiet hours
    /// would compress time.
    private var series: [ReportBucketDTO] {
        guard hourBuckets.count >= 8 else { return recent }
        let byKey = Dictionary(hourBuckets.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:00"
        return (0..<168).reversed().map { offset in
            let date = Calendar.current.date(byAdding: .hour, value: -offset, to: Date()) ?? Date()
            let key = formatter.string(from: date)
            return byKey[key] ?? emptyDayBucket(key: key)
        }
    }

    // quota cost is the default cost line; the spend line exists only while
    // the week actually billed money — the two are never summed
    private func spendOf(_ bucket: ReportBucketDTO) -> Double {
        bucket.spendCost.usd ?? bucket.spendCost.pricedSubtotalUsd
    }

    private func quotaCostOf(_ bucket: ReportBucketDTO) -> Double {
        bucket.quotaCost.usd ?? bucket.quotaCost.pricedSubtotalUsd
    }

    private var weekHasSpend: Bool {
        series.contains { $0.spendCost.pricedRows > 0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("THIS WEEK").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if !buckets.isEmpty {
                    legendSwatch(color: Theme.current().accent, label: "tokens",
                                 enabled: showTokens) { showTokens.toggle() }
                    if !privacy {
                        legendSwatch(color: Theme.current().quota, label: "quota",
                                     enabled: showQuota) { showQuota.toggle() }
                        if weekHasSpend {
                            legendSwatch(color: Theme.current().spend, label: "spend",
                                         enabled: showSpend) { showSpend.toggle() }
                        }
                    }
                }
            }
            if buckets.isEmpty {
                Text("Not enough history · snapshot only")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                GeometryReader { geometry in
                    let theme = Theme.current()
                    let tokens = series.map { $0.tokens.inputTokens + $0.tokens.outputTokens }
                    let spends = series.map { spendOf($0) }
                    let quotas = series.map { quotaCostOf($0) }
                    let drawSpend = showSpend && weekHasSpend
                    ZStack {
                        // selected day: a soft column behind the lines,
                        // aligned with the equal-width axis labels
                        if let selectedDay,
                           let index = recent.firstIndex(where: { $0.key == selectedDay }) {
                            let columnWidth = geometry.size.width / CGFloat(recent.count)
                            RoundedRectangle(cornerRadius: 3)
                                .fill(theme.accent.opacity(0.14))
                                .frame(width: columnWidth)
                                .position(x: (CGFloat(index) + 0.5) * columnWidth,
                                          y: geometry.size.height / 2)
                        }
                        if showTokens {
                            linePath(values: tokens, in: geometry.size)
                                .stroke(theme.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                        }
                        if !privacy {
                            // the visible cost lines are dollars, so they
                            // share ONE scale — each on its own max would
                            // pin both to the top and erase the comparison
                            let visibleCosts = (drawSpend ? spends : []) + (showQuota ? quotas : [])
                            let costMax = max(visibleCosts.max() ?? 1, 0.000_001)
                            if drawSpend {
                                linePath(values: spends, in: geometry.size, maximum: costMax)
                                    .stroke(theme.spend, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                            }
                            if showQuota {
                                linePath(values: quotas, in: geometry.size, maximum: costMax)
                                    .stroke(theme.quota, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                            }
                        }
                        // one hit column per day so a click anywhere in
                        // the plot selects the day under the pointer
                        if onSelectDay != nil {
                            HStack(spacing: 0) {
                                ForEach(recent, id: \.key) { bucket in
                                    Color.clear
                                        .contentShape(Rectangle())
                                        .onTapGesture { onSelectDay?(bucket.key) }
                                }
                            }
                        }
                    }
                }
                .frame(height: 64)
                HStack {
                    ForEach(recent, id: \.key) { bucket in
                        Text(String(bucket.key.suffix(5)))
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(bucket.key == selectedDay
                                ? AnyShapeStyle(Theme.current().accent)
                                : AnyShapeStyle(.secondary))
                            .fontWeight(bucket.key == selectedDay ? .semibold : .regular)
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                            .onTapGesture { onSelectDay?(bucket.key) }
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
        .accessibilityLabel(accessibilityText)
    }

    /// A legend entry doubles as the line's visibility toggle; a hidden
    /// line's entry stays in place, dimmed, so it can be brought back.
    private func legendSwatch(color: Color, label: String,
                              enabled: Bool = true, onTap: (() -> Void)? = nil) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 1).fill(color).frame(width: 10, height: 2)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .opacity(enabled ? 1 : 0.35)
        .contentShape(Rectangle())
        .onTapGesture { onTap?() }
        .help(onTap == nil ? "" : "Click to \(enabled ? "hide" : "show") the \(label) line")
    }

    /// Tokens against their own max; the two cost lines pass a shared
    /// `maximum` — same canvas, but dollars keep one axis among
    /// themselves while tokens keep theirs.
    private func linePath(values: [Double], in size: CGSize, maximum: Double? = nil) -> Path {
        let maximum = maximum ?? max(values.max() ?? 1, 0.000_001)
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
        guard !buckets.isEmpty, let last = recent.last else { return "Not enough history" }
        let tokens = formatTokens(last.tokens.inputTokens + last.tokens.outputTokens)
        return privacy
            ? "Weekly tokens, latest \(tokens). Cost hidden."
            : "Weekly tokens and quota cost\(weekHasSpend ? " and spend cost" : ""), latest \(tokens)."
    }
}

// MARK: - Model table

/// Fixed-width model breakdown shared by every drill-down (Overview day
/// cards, provider day section, provider TODAY table). Fixed numeric
/// columns keep all tables on one grid — per-table content sizing let a
/// long model name shift the columns from card to card. Rows sort
/// busiest-first; each shows its primary cost (`$` spend when the row
/// billed real money, else `~$` quota cost).
struct ModelTable: View {
    let models: [ReportBucketDTO]
    var privacy = false

    private static let promptsWidth: CGFloat = 48
    private static let tokensWidth: CGFloat = 52
    private static let costWidth: CGFloat = 62

    private var sorted: [ReportBucketDTO] {
        models.sorted { lhs, rhs in
            lhs.promptCount != rhs.promptCount ? lhs.promptCount > rhs.promptCount : lhs.key < rhs.key
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            columns(
                name: Text("Model"),
                prompts: Text("Prompts"),
                tokens: Text("Tokens"),
                cost: Text("Cost"))
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
            ForEach(sorted, id: \.key) { model in
                columns(
                    // model names identify the provider — neutralized
                    // like accounts (§11)
                    name: Text(privacy ? "Model hidden" : model.key),
                    prompts: Text("\(model.promptCount)"),
                    tokens: Text(formatTokens(model.tokens.inputTokens + model.tokens.outputTokens)),
                    cost: Text(privacy ? "hidden" : formatPrimaryCost(model)))
                    .font(.caption2).monospacedDigit()
            }
        }
    }

    private func columns(name: Text, prompts: Text, tokens: Text, cost: Text) -> some View {
        HStack(spacing: 6) {
            name.lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            prompts.frame(width: Self.promptsWidth, alignment: .trailing)
            tokens.frame(width: Self.tokensWidth, alignment: .trailing)
            cost.frame(width: Self.costWidth, alignment: .trailing)
        }
    }
}

// MARK: - Day detail

/// Drill-down for one weekly-chart day: the day's own totals, then one
/// card per agent with its models nested inside — agents and models
/// are parent and child, never two parallel lists. Each row shows its
/// primary cost (spend when the row billed real money, else `~`quota cost);
/// the day header keeps both bases separate — mixing them in one sum
/// is a category error.
struct DayDetailSection: View {
    let bucket: ReportBucketDTO
    let report: DayReportDTO?
    var privacy = false
    let onClose: () -> Void

    private var agentBuckets: [ReportBucketDTO] {
        (report?.agents.buckets ?? []).sorted { lhs, rhs in
            lhs.promptCount != rhs.promptCount ? lhs.promptCount > rhs.promptCount : lhs.key < rhs.key
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("▾ \(bucket.key)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.current().accent)
                Text("· \(bucket.promptCount) prompts")
                    .font(.caption)
                Spacer()
                Button { onClose() } label: { Image(systemName: "xmark") }
                    .buttonStyle(HoverActionButtonStyle())
                    .font(.caption2)
                    .help("Close day detail (Esc)")
            }
            Text(headerLine)
                .font(.system(size: 10)).monospacedDigit()
                .foregroundStyle(.secondary)
            if let report {
                if agentBuckets.isEmpty {
                    Text("No usage recorded for this day.")
                        .font(.caption2).foregroundStyle(.secondary)
                } else {
                    ForEach(agentBuckets, id: \.key) { agent in
                        agentCard(agent, models: report.modelsByAgent[agent.key]?.buckets ?? [])
                    }
                }
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Loading day breakdown…").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
    }

    private var headerLine: String {
        let tokens = "in \(formatTokens(bucket.tokens.inputTokens)) · out \(formatTokens(bucket.tokens.outputTokens))"
        if privacy { return tokens }
        let quota = "quota \(formatCost(bucket.quotaCost, quota: true))"
        let spend = bucket.spendCost.pricedRows > 0 || bucket.spendCost.unpricedRows > 0
            ? " · spend \(formatCost(bucket.spendCost, quota: false))"
            : ""
        return "\(quota)\(spend) · \(tokens)"
    }

    private func agentCard(_ agent: ReportBucketDTO, models: [ReportBucketDTO]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(agentDisplayName(agent.key)).font(.caption.weight(.semibold))
                Text("· \(agent.promptCount) prompts").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text(privacy ? "hidden" : formatPrimaryCost(agent))
                    .font(.caption2.weight(.semibold)).monospacedDigit()
            }
            if !models.isEmpty {
                ModelTable(models: models, privacy: privacy)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }
}

// MARK: - Provider day detail

/// Drill-down for one day on the provider's weekly chart: that day's
/// totals for this agent plus its per-model table — the provider-scoped
/// sibling of the Overview's DayDetailSection, same layout and widths.
struct ProviderDaySection: View {
    let day: String
    /// The agent's own day bucket (totals line); nil when the ledger
    /// has no rows for this agent that day.
    let bucket: ReportBucketDTO?
    /// nil = still loading; empty = loaded, nothing that day.
    let models: [ReportBucketDTO]?
    var privacy = false
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("▾ \(day)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.current().accent)
                if let bucket {
                    Text("· \(bucket.promptCount) prompts").font(.caption)
                }
                Spacer()
                if let bucket {
                    Text(privacy ? "hidden" : formatPrimaryCost(bucket))
                        .font(.caption2.weight(.semibold)).monospacedDigit()
                }
                Button { onClose() } label: { Image(systemName: "xmark") }
                    .buttonStyle(HoverActionButtonStyle())
                    .font(.caption2)
                    .help("Close day detail (Esc)")
            }
            if let models {
                if models.isEmpty {
                    Text("No usage recorded for this day.")
                        .font(.caption2).foregroundStyle(.secondary)
                } else {
                    ModelTable(models: models, privacy: privacy)
                }
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Loading day breakdown…").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
    }
}

// MARK: - Provider detail

struct ProviderDetailView: View {
    let agent: String
    let items: [AgentAttention]
    let activeAccountId: String?
    var privacy = false
    var detail: OverviewModel.ProviderDetailData?
    /// Claude switch settle window — Switch buttons count down while open.
    var switchCooldownUntil: Date?
    /// Chart-day drill-down, mirroring the Overview's: the selected day
    /// and its model buckets (nil while loading).
    var selectedDay: String? = nil
    var dayModels: [ReportBucketDTO]? = nil
    var onSelectDay: ((String?) -> Void)? = nil
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
            .reportsPanelContentHeight()
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
                    ModelTable(models: detail.modelBuckets, privacy: privacy)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
            WeeklyChart(buckets: detail.dayBuckets, privacy: privacy,
                        hourBuckets: detail.hourBuckets,
                        selectedDay: selectedDay,
                        onSelectDay: { onSelectDay?($0) })
            if let day = selectedDay {
                Divider()
                ProviderDaySection(day: day,
                                   bucket: detail.dayBuckets.first { $0.key == day },
                                   models: dayModels,
                                   privacy: privacy,
                                   onClose: { onSelectDay?(nil) })
            }
            HStack {
                // plain label: the TUI has no deep link, so naming the
                // provider promised a context the button cannot pass
                Button("Open TUI") { OpenTUI.launch() }
                    .buttonStyle(HoverActionButtonStyle())
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
                    if item.rank == .authInvalid {
                        // installing a refused login can only fail —
                        // say so instead of opening a doomed sheet
                        Text("re-login needed").font(.caption2).foregroundStyle(.orange)
                    } else if agent == "claude-code", let until = switchCooldownUntil,
                              until > Date() {
                        // settle window after a switch (Keychain reads
                        // are cached ~30s) — count down, don't bounce
                        // off the sidecar's cooldown error
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            let remaining = max(0, Int(until.timeIntervalSince(context.date).rounded(.up)))
                            Text("settling · \(remaining)s")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    } else {
                        Button("Switch") { onSwitch(snapshot) }
                            .buttonStyle(HoverActionButtonStyle())
                            .font(.caption)
                    }
                } else {
                    StatusChip(item: item)
                }
            }
            if snapshot.failure?.kind == "account_mismatch" {
                // split-brain is two facts, not one blended state: the
                // selected identity and the live credential's owner
                VStack(alignment: .leading, spacing: 2) {
                    Text("Selected: \(privacy ? "Account hidden" : (snapshot.account ?? snapshot.accountId ?? "unknown"))")
                    Text("Live credential: \(privacy ? "another account" : (snapshot.failure?.credentialOwner?.account ?? snapshot.failure?.credentialOwner?.accountId ?? "another account"))")
                    Text("A running Claude Code session reverted the switch — quit or re-login that session, then switch again.")
                        .foregroundStyle(.secondary)
                }
                .font(.caption2)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.current().warn.opacity(0.1)))
            }
            if snapshot.windows.isEmpty {
                Text("no windows reported").font(.caption2).foregroundStyle(.secondary)
            } else {
                // horizontal bars, TUI-style: label · bar · percent,
                // native id + reset underneath
                ForEach(snapshot.windows) { window in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            // same fixed column as the overview rails —
                            // bars start at one x on both screens
                            Text(railWindowLabel(window.id))
                                .font(.caption).lineLimit(1).truncationMode(.tail)
                                .frame(width: 56, alignment: .leading)
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
                        // two lines: the (possibly long) native id gets
                        // its own, ellipsized before it could wrap; the
                        // countdown ticks live underneath
                        VStack(alignment: .leading, spacing: 0) {
                            Text(window.id)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                Text(resetTextDetailed(window.resetsAtUtc, now: context.date))
                            }
                        }
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                        // label column (56) + bar gap (6)
                        .padding(.leading, 62)
                    }
                    .padding(.vertical, 1)
                }
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text("observed \(shortAge(sinceEpoch: snapshot.observedAtUtc, now: context.date)) ago · \(snapshot.source)")
            }
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
    /// Running Claude sessions, fetched when the sheet opens — nil
    /// until the preflight answers (the generic warning shows then).
    @State private var liveSessionCount: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(PrivacySetting.enabled
                 ? "Switch to \(intent.label)?"
                 : "Switch \(agentDisplayName(intent.agent)) to \(intent.label)?")
                .font(.headline)

            switch phase {
            case .confirm:
                Text(preflightWarning)
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
                // raw error text can carry emails/account ids — privacy
                // mode gets the fact of failure, not the details
                Text(PrivacySetting.enabled
                     ? "Switch failed. Details hidden (Privacy mode)."
                     : message)
                    .font(.caption)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.15)))
                // a timeout is NOT proof of rollback: the helper may
                // still be mid-switch or already done (audit grok C2-08)
                Text(message.contains("did not answer in time")
                     ? "The request timed out — the switch may still have completed. Check the accounts list before retrying."
                     : "The transaction rolled back; the live login is unchanged.")
                    .font(.caption2).foregroundStyle(.secondary)
                HStack { Spacer(); Button("Close") { dismiss() } }
            }
        }
        .padding(16)
        // narrower than the 320pt panel that presents it
        .frame(width: 300)
        .interactiveDismissDisabled(phase == .inFlight)
        .onAppear { loadPreflight() }
    }

    private var preflightWarning: String {
        guard intent.agent == "claude-code", let count = liveSessionCount else {
            return "A running session keeps its old token until restarted. Warning, not a block."
        }
        if count == 0 {
            return "No running Claude Code sessions detected — clean to switch."
        }
        return "\(count) running Claude Code session(s) may revert this switch on their next token refresh. Quit them first for a clean switch."
    }

    private func loadPreflight() {
        guard intent.agent == "claude-code" else { return }
        SidecarClient.shared.requestDecodable(
            "switchPreflight", params: ["agent": intent.agent],
            as: SwitchPreflightDTO.self
        ) { result in
            DispatchQueue.main.async {
                if case .success(let preflight) = result {
                    liveSessionCount = preflight.liveSessionPids.count
                }
            }
        }
    }

    private func run() {
        phase = .inFlight
        QuitController.switchInFlight = true
        model.performSwitch(agent: intent.agent, selector: intent.selector) { result in
            QuitController.switchInFlight = false
            switch result {
            case .success(let outcome):
                let warnings = outcome.warnings ?? []
                let pids = outcome.liveSessions ?? []
                var message = "Switched. Now following \(intent.label)."
                if !pids.isEmpty { message += " \(pids.count) running session(s) still hold the old token." }
                // core warnings can carry emails/paths — privacy keeps
                // the outcome, not the identifiers (audit grok C2-12)
                if !warnings.isEmpty && !PrivacySetting.enabled {
                    message += "\n" + warnings.joined(separator: "\n")
                }
                phase = .done(message)
            case .failure(let error):
                phase = .failed(error.localizedDescription)
            }
        }
    }
}
