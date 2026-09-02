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
    /// account_mismatch only: profile-confirmed owner of the live bytes.
    public let credentialOwner: CredentialOwnerDTO?

    public init(kind: String, failedAtUtc: Double?, retryAtUtc: Double?,
                credentialOwner: CredentialOwnerDTO? = nil) {
        self.kind = kind
        self.failedAtUtc = failedAtUtc
        self.retryAtUtc = retryAtUtc
        self.credentialOwner = credentialOwner
    }
}

public struct SwitchPreflightDTO: Decodable {
    public let liveSessionPids: [Int]

    public init(liveSessionPids: [Int]) {
        self.liveSessionPids = liveSessionPids
    }
}

public struct CredentialOwnerDTO: Decodable {
    public let accountId: String?
    public let account: String?

    public init(accountId: String?, account: String?) {
        self.accountId = accountId
        self.account = account
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
    /// Ledger rows, i.e. API calls; a prompt fans out into many.
    public let rowCount: Int
    /// Distinct prompts behind those rows — what every "Prompts" label
    /// shows. Falls back to rowCount for sidecars that predate the field.
    public let promptCount: Int
    public let tokens: TokenTotalsDTO
    /// Spend cost — real money (card / prepaid credit). Never summed
    /// with quota cost ("cost" unites the names, never the numbers).
    public let spendCost: CostResultDTO
    /// Quota cost — list-price valuation of subscription-quota consumption.
    public let quotaCost: CostResultDTO
    /// Rows whose billing nature is unclassified — in neither total.
    public let unknownRows: Int
    public let unknownUsd: Double
    public let unpricedRows: Int

    public init(key: String, rowCount: Int, tokens: TokenTotalsDTO,
                spendCost: CostResultDTO, quotaCost: CostResultDTO,
                unknownRows: Int = 0, unknownUsd: Double = 0, unpricedRows: Int = 0,
                promptCount: Int? = nil) {
        self.key = key
        self.rowCount = rowCount
        self.promptCount = promptCount ?? rowCount
        self.tokens = tokens
        self.spendCost = spendCost
        self.quotaCost = quotaCost
        self.unknownRows = unknownRows
        self.unknownUsd = unknownUsd
        self.unpricedRows = unpricedRows
    }

    private enum CodingKeys: String, CodingKey {
        case key, rowCount, promptCount, tokens, unpricedRows, unknownRows, unknownUsd
        case spendCost, quotaCost
        // older sidecars: spend/usage (billing-nature round 1), and
        // before that actual/nominal (provenance axes)
        case spend, usage, actual, nominal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        rowCount = try container.decode(Int.self, forKey: .rowCount)
        promptCount = try container.decodeIfPresent(Int.self, forKey: .promptCount) ?? rowCount
        tokens = try container.decode(TokenTotalsDTO.self, forKey: .tokens)
        unpricedRows = try container.decodeIfPresent(Int.self, forKey: .unpricedRows) ?? 0
        unknownRows = try container.decodeIfPresent(Int.self, forKey: .unknownRows) ?? 0
        unknownUsd = try container.decodeIfPresent(Double.self, forKey: .unknownUsd) ?? 0
        let empty = CostResultDTO(usd: nil, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 0)
        // legacy fallback chain: a pre-rename sidecar's "usage" IS the
        // quota cost, and the pre-billing-nature "actual" was
        // quota-stamped money on this data — both degrade into the new
        // fields rather than failing the whole decode
        spendCost = try container.decodeIfPresent(CostResultDTO.self, forKey: .spendCost)
            ?? container.decodeIfPresent(CostResultDTO.self, forKey: .spend)
            ?? empty
        quotaCost = try container.decodeIfPresent(CostResultDTO.self, forKey: .quotaCost)
            ?? container.decodeIfPresent(CostResultDTO.self, forKey: .usage)
            ?? container.decodeIfPresent(CostResultDTO.self, forKey: .nominal)
            ?? container.decodeIfPresent(CostResultDTO.self, forKey: .actual)
            ?? empty
    }
}

public struct PromptRowDTO: Decodable {
    public let id: Int
    public let tsUtc: Double
    public let agent: String
    public let model: String?
    public let text: String?
}

public struct PromptListDTO: Decodable {
    public let rows: [PromptRowDTO]
}

public struct ReportSummaryDTO: Decodable {
    public let buckets: [ReportBucketDTO]
    public let totals: ReportBucketDTO
}

public struct OverviewDTO: Decodable {
    public let quota: [QuotaSnapshotDTO]
    public let report: ReportSummaryDTO
}

/// One selected calendar day: per-agent buckets plus each agent's
/// per-model buckets — the nesting the day drill-down renders.
public struct DayReportDTO: Decodable {
    public let agents: ReportSummaryDTO
    public let modelsByAgent: [String: ReportSummaryDTO]

    public init(agents: ReportSummaryDTO, modelsByAgent: [String: ReportSummaryDTO]) {
        self.agents = agents
        self.modelsByAgent = modelsByAgent
    }
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
    "cursor-cli": "Cursor",
]

/// Monochrome short codes — vertical_text identity and VO labels.
public let AGENT_SHORT_CODES: [String: String] = [
    "claude-code": "CLA",
    "codex": "CDX",
    "antigravity": "AGY",
    "opencode": "OPC",
    "cline": "CLN",
    "grok": "GRK",
    "cursor-cli": "CUR",
]

public let SWITCHABLE_AGENTS: Set<String> = [
    "claude-code", "codex", "opencode", "grok", "cursor-cli",
]

public let BRAND_GLYPH_AGENTS: Set<String> = [
    "claude-code", "antigravity", "opencode", "codex", "cline", "grok", "cursor-cli",
]

public func agentHasBrandGlyph(_ agent: String) -> Bool {
    BRAND_GLYPH_AGENTS.contains(agent)
}

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

/// The one cost figure that means something for this bucket: spend cost
/// when any real money was involved, quota cost otherwise. Data decides
/// — never a setting — and the `~` prefix keeps the chosen basis
/// visible. Totals must NOT use this: summing billed and quota-valued
/// dollars is a category error (mirrors the TUI's primaryCostViewModel).
public func primaryCost(_ bucket: ReportBucketDTO) -> (cost: CostResultDTO?, isQuota: Bool) {
    if bucket.spendCost.pricedRows > 0 {
        return (bucket.spendCost, false)
    }
    return (bucket.quotaCost, true)
}

/// `$1.23` (spend cost) / `~$1.23` (quota cost) / trailing `+` when
/// partial / `—` when neither basis priced anything.
public func formatPrimaryCost(_ bucket: ReportBucketDTO) -> String {
    let (cost, isQuota) = primaryCost(bucket)
    return formatCost(cost, quota: isQuota)
}

/// One basis, formatted the same way (`+` marks a partial subtotal).
public func formatCost(_ cost: CostResultDTO?, quota: Bool) -> String {
    guard let cost else { return "—" }
    let prefix = quota ? "~" : ""
    if let usd = cost.usd { return prefix + formatUsd(usd) }
    if cost.pricedRows > 0 { return prefix + formatUsd(cost.pricedSubtotalUsd) + "+" }
    return "—"
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

/// Detail surfaces pair the countdown with the absolute local time:
/// `resets in 2h 5m · 08-14 (Thu) 16:27` (§4). The month-day keeps a
/// monthly reset unambiguous — a weekday alone names four candidate
/// days. NULL stays `no reset`.
public func resetTextDetailed(_ resetsAtUtc: Double?, now: Date = Date()) -> String {
    guard let resetsAtUtc else { return "no reset" }
    let relative = resetText(resetsAtUtc, now: now)
    let formatter = DateFormatter()
    // the UI is English; a system locale must not localize the weekday
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "MM-dd (EEE) HH:mm"
    let absolute = formatter.string(from: Date(timeIntervalSince1970: epochSeconds(resetsAtUtc)))
    return "\(relative) · \(absolute)"
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

/// A calendar slot the ledger has no rows for: zero usage is a fact
/// (nothing was spent), not missing data — charts fill gaps with this
/// instead of skipping days and distorting the time axis.
public func emptyDayBucket(key: String) -> ReportBucketDTO {
    let empty = CostResultDTO(usd: nil, pricedSubtotalUsd: 0, pricedRows: 0, unpricedRows: 0)
    return ReportBucketDTO(
        key: key,
        rowCount: 0,
        tokens: TokenTotalsDTO(inputTokens: 0, outputTokens: 0),
        spendCost: empty,
        quotaCost: empty)
}
