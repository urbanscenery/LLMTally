import Foundation
import LLMTallyKit

/// Popover state: one load = `overview` + `activeAccounts` in flight
/// together. Last-good stays on screen during a refresh — data is never
/// hidden behind a spinner once it exists (design principle: no
/// skeleton over stale truth).
@MainActor
final class OverviewModel: ObservableObject {
    /// One instance for the app's lifetime: reopening the panel must
    /// paint the previous data instantly (iStat-style) instead of
    /// starting from an empty model and waiting out a live fetch.
    static let shared = OverviewModel()

    struct ProviderDetailData {
        let modelBuckets: [ReportBucketDTO]
        let dayBuckets: [ReportBucketDTO]
        let hourBuckets: [ReportBucketDTO]
    }

    @Published var overview: OverviewDTO?
    @Published var activeAccounts: [String: String?] = [:]
    @Published var hourBuckets: [ReportBucketDTO] = []
    @Published var providerDetails: [String: ProviderDetailData] = [:]
    /// Weekly-chart day the Overview drilled into; nil shows no detail.
    @Published var selectedDay: String?
    /// Per-day drill-down payloads — last-good paints instantly on
    /// re-selection while the fresh read lands behind it.
    @Published var dayReports: [String: DayReportDTO] = [:]
    /// Provider detail's own chart-day drill-down; independent of the
    /// Overview's so going back never carries a stale selection along.
    @Published var providerSelectedDay: String?
    /// Model buckets per "\(agent)|\(day)" — same last-good policy.
    @Published var providerDayModels: [String: [ReportBucketDTO]] = [:]

    /// Last 7 local days — hour-grain report params shared by the
    /// weekly lines (resolution) and the 5h/24h status sparks.
    nonisolated static func hourReportParams(agent: String? = nil) -> [String: Any] {
        var params: [String: Any] = [
            "groupBy": "hour",
            // calendar days, not fixed 86,400s spans — a DST switch
            // otherwise shifts the window by an hour and drops or adds
            // a day at the boundary (audit C1-15)
            "fromDate": localDayKey(
                Calendar.current.date(byAdding: .day, value: -6, to: Date()) ?? Date()),
            "toDate": localDayKey(),
            "noRefresh": true,
        ]
        if let agent { params["agent"] = agent }
        return params
    }
    @Published var loading = false
    @Published var loadError: String?
    @Published var lastLoadedAt: Date?
    /// Claude switch settle window — mirrors core's cooldown (Keychain
    /// reads are cached ~30s by Claude Code; core holds 45s). The
    /// buttons count down instead of bouncing off the sidecar's error.
    @Published var switchCooldownUntil: Date?
    static let switchCooldownSeconds: TimeInterval = 45

    /// A user Refresh during a background load must not be dropped —
    /// it re-runs when the in-flight batch settles (audit grok C3-10).
    private var pendingUserRefresh = false

    /// Panel-open policy: whatever is cached paints first, the live
    /// vendor round-trip (seconds) happens behind it. A cold model
    /// reads stored state (`refresh: false`, fast) and queues the live
    /// pass; a warm model already shows last-good, so it goes straight
    /// to the live pass without hiding anything.
    func loadOnAppear() {
        guard overview == nil else {
            load(refresh: true)
            return
        }
        pendingUserRefresh = true
        load(refresh: false)
    }

    /// Absorb the status item's background fetch so the next panel
    /// open paints data from the last background tick, not from the
    /// last time the panel itself was open. Skipped while a
    /// panel-driven load is in flight — that response is newer and
    /// must not be clobbered by a tick that raced it.
    func absorb(overview: OverviewDTO, activeAccounts: [String: String?]?,
                hourBuckets: [ReportBucketDTO]?) {
        guard !loading else { return }
        self.overview = overview
        if let activeAccounts { self.activeAccounts = activeAccounts }
        if let hourBuckets { self.hourBuckets = hourBuckets }
        lastLoadedAt = Date()
    }

    func load(refresh: Bool) {
        guard !loading else {
            if refresh { pendingUserRefresh = true }
            return
        }
        loading = true
        loadError = nil

        let group = DispatchGroup()
        var overviewResult: Result<OverviewDTO, Error>?
        var activeResult: Result<[String: String?], Error>?

        group.enter()
        SidecarClient.shared.requestDecodable("overview", params: ["refresh": refresh], as: OverviewDTO.self) { result in
            overviewResult = result
            group.leave()
        }
        group.enter()
        SidecarClient.shared.requestDecodable("activeAccounts", as: [String: String?].self) { result in
            activeResult = result
            group.leave()
        }
        var hourResult: [ReportBucketDTO]?
        group.enter()
        SidecarClient.shared.requestDecodable("report", params: Self.hourReportParams(), as: ReportSummaryDTO.self) { result in
            if case .success(let summary) = result { hourResult = summary.buckets }
            group.leave()
        }

        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.loading = false
            switch overviewResult {
            case .success(let dto):
                self.overview = dto
                self.lastLoadedAt = Date()
            case .failure(let error):
                // keep last-good on screen; surface the failure as text
                self.loadError = error.localizedDescription
            case nil:
                self.loadError = "no response"
            }
            if case .success(let active) = activeResult {
                self.activeAccounts = active
            }
            if let hourResult {
                self.hourBuckets = hourResult
            }
            if self.pendingUserRefresh {
                self.pendingUserRefresh = false
                self.load(refresh: true)
            }
        }
    }

    /// The largest retry countdown among rate-limited snapshots — the
    /// footer locks Refresh behind it (§3, 429 state).
    var retryAfterSeconds: Double? {
        overview?.quota
            .filter { $0.failure?.kind == "rate_limited" }
            .compactMap(\.retryAfterSeconds)
            .max()
    }

    /// Weekly-chart day selection: clicking the selected day again (or
    /// passing nil) closes the detail. The cache paints instantly and a
    /// fresh read lands behind it — today's bucket is still moving.
    func selectDay(_ key: String?) {
        guard let key, key != selectedDay else {
            selectedDay = nil
            return
        }
        selectedDay = key
        loadDayReport(date: key)
    }

    private func loadDayReport(date: String) {
        SidecarClient.shared.requestDecodable(
            "dayReport", params: ["date": date], as: DayReportDTO.self
        ) { result in
            DispatchQueue.main.async { [weak self] in
                if case .success(let report) = result {
                    self?.dayReports[date] = report
                }
            }
        }
    }

    /// Provider chart-day selection — same toggle/cache/refresh policy
    /// as the Overview's selectDay.
    func selectProviderDay(agent: String, _ key: String?) {
        guard let key, key != providerSelectedDay else {
            providerSelectedDay = nil
            return
        }
        providerSelectedDay = key
        SidecarClient.shared.requestDecodable(
            "report",
            params: ["groupBy": "model", "agent": agent, "fromDate": key, "toDate": key, "noRefresh": true],
            as: ReportSummaryDTO.self
        ) { result in
            DispatchQueue.main.async { [weak self] in
                if case .success(let summary) = result {
                    self?.providerDayModels["\(agent)|\(key)"] = summary.buckets
                }
            }
        }
    }

    /// Provider detail's lower half: today by model + weekly days.
    func loadProviderDetail(agent: String) {
        let today = localDayKey()
        var models: [ReportBucketDTO]?
        var days: [ReportBucketDTO]?
        let group = DispatchGroup()

        group.enter()
        SidecarClient.shared.requestDecodable(
            "report",
            params: ["groupBy": "model", "agent": agent, "fromDate": today, "toDate": today, "noRefresh": true],
            as: ReportSummaryDTO.self
        ) { result in
            if case .success(let summary) = result { models = summary.buckets }
            group.leave()
        }
        group.enter()
        SidecarClient.shared.requestDecodable(
            "report",
            params: ["groupBy": "day", "agent": agent, "noRefresh": true],
            as: ReportSummaryDTO.self
        ) { result in
            if case .success(let summary) = result { days = summary.buckets }
            group.leave()
        }
        var hours: [ReportBucketDTO]?
        group.enter()
        SidecarClient.shared.requestDecodable(
            "report", params: Self.hourReportParams(agent: agent), as: ReportSummaryDTO.self
        ) { result in
            if case .success(let summary) = result { hours = summary.buckets }
            group.leave()
        }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.providerDetails[agent] = ProviderDetailData(
                modelBuckets: models ?? [],
                dayBuckets: days ?? [],
                hourBuckets: hours ?? [])
        }
    }

    func performSwitch(agent: String, selector: String,
                       completion: @escaping (Result<SwitchResultDTO, Error>) -> Void) {
        SidecarClient.shared.requestDecodable(
            "switchAccount",
            params: ["agent": agent, "selector": selector],
            as: SwitchResultDTO.self
        ) { result in
            DispatchQueue.main.async {
                completion(result)
                if case .success = result {
                    if agent == "claude-code" {
                        self.beginSwitchCooldown()
                    }
                    // the new active identity must be reflected everywhere
                    self.load(refresh: true)
                }
            }
        }
    }

    private func beginSwitchCooldown() {
        let until = Date().addingTimeInterval(Self.switchCooldownSeconds)
        switchCooldownUntil = until
        // republish at expiry so the Switch buttons come back without
        // waiting for the next data reload
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.switchCooldownSeconds + 0.5) { [weak self] in
            guard let self, let current = self.switchCooldownUntil, current <= Date() else { return }
            self.switchCooldownUntil = nil
        }
    }

    /// Snapshots grouped per agent — a manual order (Settings →
    /// Overview) wins; otherwise rows rank by attention.
    func agentGroups(now: Date = Date()) -> [(agent: String, items: [AgentAttention])] {
        guard let overview else { return [] }
        let hidden = HiddenAgents.all()
        var byAgent: [String: [AgentAttention]] = [:]
        for snapshot in overview.quota where !hidden.contains(snapshot.agent) {
            byAgent[snapshot.agent, default: []].append(attention(for: snapshot, now: now))
        }
        let groups = byAgent.map { (agent: $0.key, items: $0.value.sorted { $0.rank < $1.rank }) }
        if let order = ProviderOrder.saved() {
            return groups.sorted { lhs, rhs in
                (order.firstIndex(of: lhs.agent) ?? Int.max, lhs.agent)
                    < (order.firstIndex(of: rhs.agent) ?? Int.max, rhs.agent)
            }
        }
        return groups.sorted { lhs, rhs in
            let l = lhs.items.first?.rank ?? .quiet
            let r = rhs.items.first?.rank ?? .quiet
            if l != r { return l < r }
            return lhs.agent < rhs.agent
        }
    }

    /// The row shown on Overview: the agent's active account when known,
    /// otherwise its highest-attention snapshot.
    func overviewRow(for group: (agent: String, items: [AgentAttention])) -> AgentAttention? {
        if let activeId = activeAccounts[group.agent] ?? nil,
           let active = group.items.first(where: { $0.snapshot.accountId == activeId }) {
            return active
        }
        return group.items.first
    }

    func headline(now: Date = Date()) -> AgentAttention? {
        headlineAttention(agentGroups(now: now).compactMap { overviewRow(for: $0) })
    }

    func todayBucket() -> ReportBucketDTO? {
        overview?.report.buckets.first { $0.key == localDayKey() }
    }
}
