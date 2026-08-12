import Foundation

// DTOs mirroring the sidecar contract
// (local_docs/mac_menubar_app_init/04_sidecar_contract.md). Extra JSON
// keys are ignored by Decodable, so core can grow payloads freely.

public struct QuotaWindowDTO: Decodable, Identifiable {
    public let id: String
    public let usedPercent: Double
    public let resetsAtUtc: Double?

    public init(id: String, usedPercent: Double, resetsAtUtc: Double?) {
        self.id = id
        self.usedPercent = usedPercent
        self.resetsAtUtc = resetsAtUtc
    }
}

public struct QuotaFailureDTO: Decodable {
    public let kind: String
    public let failedAtUtc: Double?
    public let retryAtUtc: Double?

    public init(kind: String, failedAtUtc: Double?, retryAtUtc: Double?) {
        self.kind = kind
        self.failedAtUtc = failedAtUtc
        self.retryAtUtc = retryAtUtc
    }
}

public struct QuotaSnapshotDTO: Decodable {
    public let agent: String
    public let accountId: String?
    public let account: String?
    public let plan: String?
    public let source: String
    public let observedAtUtc: Double
    public let windows: [QuotaWindowDTO]
    public let failure: QuotaFailureDTO?
    public let retryAfterSeconds: Double?
    public let warnings: [String]

    public init(agent: String, accountId: String?, account: String?, plan: String?,
                source: String, observedAtUtc: Double, windows: [QuotaWindowDTO],
                failure: QuotaFailureDTO?, retryAfterSeconds: Double?, warnings: [String]) {
        self.agent = agent
        self.accountId = accountId
        self.account = account
        self.plan = plan
        self.source = source
        self.observedAtUtc = observedAtUtc
        self.windows = windows
        self.failure = failure
        self.retryAfterSeconds = retryAfterSeconds
        self.warnings = warnings
    }
}

public struct TokenTotalsDTO: Decodable {
    public let inputTokens: Double
    public let outputTokens: Double
    public let cacheWrite: Double
    public let cacheRead: Double
    public let reasoningTokens: Double

    public init(inputTokens: Double, outputTokens: Double, cacheWrite: Double = 0,
                cacheRead: Double = 0, reasoningTokens: Double = 0) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheWrite = cacheWrite
        self.cacheRead = cacheRead
        self.reasoningTokens = reasoningTokens
    }
}

public struct CostResultDTO: Decodable {
    public let usd: Double?
    public let pricedSubtotalUsd: Double
    public let pricedRows: Int
    public let unpricedRows: Int

    public init(usd: Double?, pricedSubtotalUsd: Double, pricedRows: Int, unpricedRows: Int) {
        self.usd = usd
        self.pricedSubtotalUsd = pricedSubtotalUsd
        self.pricedRows = pricedRows
        self.unpricedRows = unpricedRows
    }
}

public struct ReportBucketDTO: Decodable {
    public let key: String
    public let rowCount: Int
    public let tokens: TokenTotalsDTO
    public let actual: CostResultDTO
    public let unpricedRows: Int

    public init(key: String, rowCount: Int, tokens: TokenTotalsDTO,
                actual: CostResultDTO, unpricedRows: Int = 0) {
        self.key = key
        self.rowCount = rowCount
        self.tokens = tokens
        self.actual = actual
        self.unpricedRows = unpricedRows
    }
}

public struct ReportSummaryDTO: Decodable {
    public let buckets: [ReportBucketDTO]
    public let totals: ReportBucketDTO
}

public struct OverviewDTO: Decodable {
    public let quota: [QuotaSnapshotDTO]
    public let report: ReportSummaryDTO
}

public struct SwitchResultDTO: Decodable {
    public let outgoing: String?
    public let backend: String?
    public let stashId: String?
    public let liveSessions: [Int]?
    public let warnings: [String]?
}

// Formatting helpers shared by the popover views and the status item.

public let AGENT_DISPLAY_NAMES: [String: String] = [
    "claude-code": "Claude",
    "codex": "Codex",
    "antigravity": "Antigravity",
    "opencode": "OpenCode",
    "cline": "Cline",
    "grok": "Grok",
]

/// Monochrome short codes — vertical_text identity and VO labels.
public let AGENT_SHORT_CODES: [String: String] = [
    "claude-code": "CLA",
    "codex": "CDX",
    "antigravity": "AGY",
    "opencode": "OPC",
    "cline": "CLN",
    "grok": "GRK",
]

public let SWITCHABLE_AGENTS: Set<String> = ["claude-code", "codex", "opencode"]

public func agentDisplayName(_ agent: String) -> String {
    AGENT_DISPLAY_NAMES[agent] ?? agent
}

public func agentShortCode(_ agent: String) -> String {
    AGENT_SHORT_CODES[agent] ?? "?"
}

/// The ledger stores UTC epochs; tolerate either seconds or milliseconds.
public func epochSeconds(_ raw: Double) -> Double {
    raw > 1_000_000_000_000 ? raw / 1000 : raw
}

public func formatTokens(_ value: Double) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
    if value >= 1_000 { return String(format: "%.0fk", value / 1_000) }
    return String(format: "%.0f", value)
}

public func formatUsd(_ value: Double) -> String {
    value >= 100 ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
}

/// `42s` / `3m` / `8h 16m` / `5d 18h` since the given epoch.
public func shortAge(sinceEpoch raw: Double, now: Date = Date()) -> String {
    let seconds = max(0, now.timeIntervalSince1970 - epochSeconds(raw))
    return shortDuration(seconds)
}

public func shortDuration(_ seconds: Double) -> String {
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
public func resetText(_ resetsAtUtc: Double?, now: Date = Date()) -> String {
    guard let resetsAtUtc else { return "no reset" }
    let remaining = epochSeconds(resetsAtUtc) - now.timeIntervalSince1970
    if remaining <= 0 { return "resetting" }
    return "resets in \(shortDuration(remaining))"
}

/// Compact window label for tight surfaces; the exact native id stays
/// in tooltips and VO.
public func shortWindowLabel(_ id: String) -> String {
    if id.contains("five_hour") || id.contains("300m") { return "5h" }
    if id.contains("seven_day") || id.contains("10080m") || id.hasPrefix("7d") { return "7d" }
    if id.lowercased().contains("fable") { return "Fable" }
    if id.contains("1month") || id == "monthly" { return "1mo" }
    if id == "weekly" { return "7d" }
    return String(id.prefix(6))
}

public func localDayKey(_ date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}
