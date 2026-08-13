import Foundation
import LLMTallyKit

/// Popover state: one load = `overview` + `activeAccounts` in flight
/// together. Last-good stays on screen during a refresh — data is never
/// hidden behind a spinner once it exists (design principle: no
/// skeleton over stale truth).
@MainActor
final class OverviewModel: ObservableObject {
    struct ProviderDetailData {
        let modelBuckets: [ReportBucketDTO]
        let dayBuckets: [ReportBucketDTO]
    }

    @Published var overview: OverviewDTO?
    @Published var activeAccounts: [String: String?] = [:]
    @Published var lastPrompt: PromptRowDTO?
    @Published var providerDetails: [String: ProviderDetailData] = [:]
    @Published var loading = false
    @Published var loadError: String?
    @Published var lastLoadedAt: Date?

    func load(refresh: Bool) {
        guard !loading else { return }
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
        var promptResult: PromptRowDTO?
        group.enter()
        SidecarClient.shared.requestDecodable("prompts", params: ["limit": 1], as: PromptListDTO.self) { result in
            if case .success(let list) = result { promptResult = list.rows.first }
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
            if let promptResult {
                self.lastPrompt = promptResult
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
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.providerDetails[agent] = ProviderDetailData(
                modelBuckets: models ?? [],
                dayBuckets: days ?? [])
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
                    // the new active identity must be reflected everywhere
                    self.load(refresh: true)
                }
            }
        }
    }

    /// Snapshots grouped per agent, ordered by attention.
    func agentGroups(now: Date = Date()) -> [(agent: String, items: [AgentAttention])] {
        guard let overview else { return [] }
        let hidden = HiddenAgents.all()
        var byAgent: [String: [AgentAttention]] = [:]
        for snapshot in overview.quota where !hidden.contains(snapshot.agent) {
            byAgent[snapshot.agent, default: []].append(attention(for: snapshot, now: now))
        }
        return byAgent
            .map { (agent: $0.key, items: $0.value.sorted { $0.rank < $1.rank }) }
            .sorted { lhs, rhs in
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
