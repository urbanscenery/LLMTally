import Foundation

// DTOs mirroring the sidecar contract
// (local_docs/mac_menubar_app_init/04_sidecar_contract.md). Extra JSON
// keys are ignored by Decodable, so core can grow payloads freely.

struct QuotaWindowDTO: Decodable, Identifiable {
    let id: String
    let usedPercent: Double
    let resetsAtUtc: Double?
}

struct QuotaFailureDTO: Decodable {
    let kind: String
    let failedAtUtc: Double?
    let retryAtUtc: Double?
}

struct QuotaSnapshotDTO: Decodable {
    let agent: String
    let accountId: String?
    let account: String?
    let plan: String?
    let source: String
    let observedAtUtc: Double
    let windows: [QuotaWindowDTO]
    let failure: QuotaFailureDTO?
    let retryAfterSeconds: Double?
    let warnings: [String]
}

struct TokenTotalsDTO: Decodable {
    let inputTokens: Double
    let outputTokens: Double
    let cacheWrite: Double
    let cacheRead: Double
    let reasoningTokens: Double
}

struct CostResultDTO: Decodable {
    let usd: Double?
    let pricedSubtotalUsd: Double
    let pricedRows: Int
    let unpricedRows: Int
}

struct ReportBucketDTO: Decodable {
    let key: String
    let rowCount: Int
    let tokens: TokenTotalsDTO
    let actual: CostResultDTO
    let unpricedRows: Int
}

struct ReportSummaryDTO: Decodable {
    let buckets: [ReportBucketDTO]
    let totals: ReportBucketDTO
}

struct OverviewDTO: Decodable {
    let quota: [QuotaSnapshotDTO]
    let report: ReportSummaryDTO
}

struct SwitchResultDTO: Decodable {
    let outgoing: String?
    let backend: String?
    let stashId: String?
    let liveSessions: [Int]?
    let warnings: [String]?
}

// Formatting helpers shared by the popover views.

let AGENT_DISPLAY_NAMES: [String: String] = [
    "claude-code": "Claude",
    "codex": "Codex",
    "antigravity": "Antigravity",
    "opencode": "OpenCode",
    "cline": "Cline",
    "grok": "Grok",
]

let SWITCHABLE_AGENTS: Set<String> = ["claude-code", "codex", "opencode"]

func agentDisplayName(_ agent: String) -> String {
    AGENT_DISPLAY_NAMES[agent] ?? agent
}

/// The ledger stores UTC epochs; tolerate either seconds or milliseconds.
func epochSeconds(_ raw: Double) -> Double {
    raw > 1_000_000_000_000 ? raw / 1000 : raw
}

func formatTokens(_ value: Double) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
    if value >= 1_000 { return String(format: "%.0fk", value / 1_000) }
    return String(format: "%.0f", value)
}

func formatUsd(_ value: Double) -> String {
    value >= 100 ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
}

/// `42s` / `3m` / `8h 16m` / `5d 18h` since the given epoch.
func shortAge(sinceEpoch raw: Double, now: Date = Date()) -> String {
    let seconds = max(0, now.timeIntervalSince1970 - epochSeconds(raw))
    return shortDuration(seconds)
}

func shortDuration(_ seconds: Double) -> String {
    if seconds < 60 { return String(format: "%.0fs", seconds) }
    if seconds < 3600 { return String(format: "%.0fm", seconds / 60) }
    if seconds < 86_400 {
        let hours = Int(seconds) / 3600
        let minutes = (Int(seconds) % 3600) / 60
        return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m"
    }
    let days = Int(seconds) / 86_400
    let hours = (Int(seconds) % 86_400) / 3600
    return hours == 0 ? "\(days)d" : "\(days)d \(hours)h"
}

/// `resets in 2h 5m` — or `no reset` when the source returned NULL.
/// A NULL reset never becomes a fake countdown (data contract).
func resetText(_ resetsAtUtc: Double?, now: Date = Date()) -> String {
    guard let resetsAtUtc else { return "no reset" }
    let remaining = epochSeconds(resetsAtUtc) - now.timeIntervalSince1970
    if remaining <= 0 { return "resetting" }
    return "resets in \(shortDuration(remaining))"
}

func localDayKey(_ date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}
