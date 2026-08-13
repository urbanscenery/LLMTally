import Foundation

/// Renders the ordered descriptor array against the latest quota data
/// into the status-item title and its tooltip. Pure text in/out so the
/// same function serves the future Builder preview — the design's
/// "same renderer" rule, at least for the textual layer.
///
/// Rules carried from 03_design_spec:
/// - freshness glyphs: `●` fresh · `◷` stale/429 · `!` auth
/// - a missing capability renders `—` (placeholder) or nothing
///   (hidden), never `0%`
/// - compact text may drop labels, but the tooltip keeps provider,
///   exact native window id, direction, reset, freshness.
public struct StatusRendering: Equatable {
    public let title: String
    public let tooltip: String
}

public func renderStatusItems(
    descriptors: [MenuItemDescriptor],
    quota: [QuotaSnapshotDTO],
    activeAccounts: [String: String?],
    privacy: Bool = false,
    now: Date = Date()
) -> StatusRendering {
    // privacy mode neutralizes identity in the visible text AND the
    // tooltip/VO payload — a real replacement, not a visual mask
    let names = PrivacyNames(privacy: privacy, quota: quota)
    // One row per agent: the active account when known, else the
    // highest-attention snapshot — the same choice Overview makes.
    var rowsByAgent: [String: AgentAttention] = [:]
    for snapshot in quota {
        let candidate = attention(for: snapshot, now: now)
        let activeId = activeAccounts[snapshot.agent] ?? nil
        if let existing = rowsByAgent[snapshot.agent] {
            let existingIsActive = existing.snapshot.accountId != nil && existing.snapshot.accountId == activeId
            let candidateIsActive = candidate.snapshot.accountId != nil && candidate.snapshot.accountId == activeId
            if candidateIsActive || (!existingIsActive && candidate.rank < existing.rank) {
                rowsByAgent[snapshot.agent] = candidate
            }
        } else {
            rowsByAgent[snapshot.agent] = candidate
        }
    }
    let rows = Array(rowsByAgent.values)

    var segments: [String] = []
    var tooltipLines: [String] = []

    for descriptor in descriptors {
        switch descriptor.metric {
        case .quotaUsagePercentage:
            renderQuotaPercent(descriptor, rows: rows, names: names, now: now,
                               segments: &segments, tooltip: &tooltipLines)
        case .sourceFreshness:
            renderFreshness(rows: rows, names: names, now: now,
                            segments: &segments, tooltip: &tooltipLines)
        case .quotaReset:
            renderReset(descriptor, rows: rows, now: now, segments: &segments, tooltip: &tooltipLines)
        case .providerLabel:
            if case .provider(let provider) = descriptor.scope {
                segments.append(names.code(provider))
            } else if case .pin(let provider, _) = descriptor.binding {
                segments.append(names.code(provider))
            }
        case .spacer:
            segments.append(" ")
        case .quotaMiniBar, .consumedTokenHistory, .actualCostHistory, .agentActive:
            // graphical metrics need the image renderer (next phase);
            // text layer honours the unavailable behaviour instead
            if descriptor.unavailableBehavior == "placeholder" {
                segments.append("—")
            }
        }
    }

    let title = segments.joined(separator: " ").trimmingCharacters(in: .whitespaces)
    return StatusRendering(
        title: title.isEmpty ? "tally" : title,
        tooltip: tooltipLines.joined(separator: "\n"))
}

// MARK: - metric renderers

private func renderQuotaPercent(
    _ descriptor: MenuItemDescriptor,
    rows: [AgentAttention],
    names: PrivacyNames,
    now: Date,
    segments: inout [String],
    tooltip: inout [String]
) {
    guard let resolved = resolveQuotaBinding(descriptor, rows: rows) else {
        if descriptor.unavailableBehavior == "placeholder" { segments.append("—") }
        tooltip.append("quota: window not returned by the source")
        return
    }
    let (item, window) = resolved

    if item.rank == .authInvalid {
        segments.append("\(identityText(descriptor, code: names.code(item.snapshot.agent)))!")
        tooltip.append("\(names.display(item.snapshot.agent)) auth invalid · reconnect required")
        return
    }

    guard let window else {
        if descriptor.unavailableBehavior == "placeholder" { segments.append("—") }
        tooltip.append("\(names.display(item.snapshot.agent)): no windows reported")
        return
    }

    let direction = descriptor.direction ?? "used"
    let percent = direction == "remaining"
        ? 100 - Int(window.usedPercent.rounded())
        : Int(window.usedPercent.rounded())

    var parts: [String] = []
    let identity = identityText(descriptor, code: names.code(item.snapshot.agent))
    if !identity.isEmpty { parts.append(identity) }
    if descriptor.showWindowLabel ?? true { parts.append(shortWindowLabel(window.id)) }
    if descriptor.showPercentage ?? true { parts.append("\(percent)%") }
    segments.append(parts.joined(separator: " "))

    tooltip.append(
        "\(names.display(item.snapshot.agent)) \(window.id) \(direction) "
        + "\(Int(window.usedPercent.rounded()))% · \(resetText(window.resetsAtUtc, now: now))"
        + " · \(names.account(item.snapshot.account))")
}

private func renderFreshness(
    rows: [AgentAttention],
    names: PrivacyNames,
    now: Date,
    segments: inout [String],
    tooltip: inout [String]
) {
    guard !rows.isEmpty else { return }
    let worst = rows.min { $0.rank < $1.rank }
    let oldest = rows.map { epochSeconds($0.snapshot.observedAtUtc) }.min() ?? now.timeIntervalSince1970

    let glyph: String
    switch worst?.rank {
    case .authInvalid: glyph = "!"
    case .rateLimited, .stale: glyph = "◷"
    default: glyph = "●"
    }
    segments.append("\(glyph) \(shortAge(sinceEpoch: oldest, now: now))")

    for row in rows {
        tooltip.append(
            "\(names.display(row.snapshot.agent)): \(row.snapshot.source), "
            + "observed \(shortAge(sinceEpoch: row.snapshot.observedAtUtc, now: now)) ago")
    }
}

private func renderReset(
    _ descriptor: MenuItemDescriptor,
    rows: [AgentAttention],
    now: Date,
    segments: inout [String],
    tooltip: inout [String]
) {
    guard let resolved = resolveQuotaBinding(descriptor, rows: rows),
          let window = resolved.1,
          window.resetsAtUtc != nil else {
        // NULL reset never becomes a fake countdown
        if descriptor.unavailableBehavior == "placeholder" { segments.append("—") }
        return
    }
    if descriptor.resetDisplay == "at" {
        // absolute local time — the countdown's alternative reading
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE HH:mm"
        segments.append(formatter.string(
            from: Date(timeIntervalSince1970: epochSeconds(window.resetsAtUtc ?? 0))))
    } else {
        let remaining = epochSeconds(window.resetsAtUtc ?? 0) - now.timeIntervalSince1970
        segments.append(remaining > 0 ? shortDuration(remaining) : "reset")
    }
    tooltip.append("\(window.id) \(resetText(window.resetsAtUtc, now: now))")
}

// MARK: - helpers

private func resolveQuotaBinding(
    _ descriptor: MenuItemDescriptor,
    rows: [AgentAttention]
) -> (AgentAttention, QuotaWindowDTO?)? {
    switch descriptor.binding {
    case .pin(let provider, let nativeWindowId):
        guard let item = rows.first(where: { $0.snapshot.agent == provider }) else { return nil }
        let window = item.snapshot.windows.first { $0.id == nativeWindowId }
        // a vanished dynamic id is unavailable, never fuzzy-matched
        return (item, window)
    case .followAttention, nil:
        guard let item = headlineAttention(rows) else { return nil }
        return (item, item.topWindow)
    }
}

private func identityText(_ descriptor: MenuItemDescriptor, code: String) -> String {
    switch descriptor.providerIdentityPresentation {
    case "none": return ""
    default: return code
    }
}

// MARK: - segment renderer (graphical layer)

/// One drawable unit of the status item. The app composes these into
/// an image; the Builder preview composes the same segments — one
/// renderer, two surfaces (03_design_spec §6.1).
public enum StatusSegment: Equatable {
    case text(String)
    /// Monochrome provider glyph — emitted when identity is "icon".
    case glyph(agent: String)
    /// Vertical bottom-anchored rails — identity code + one bar per
    /// actual native window. `remaining` inverts the fill height while
    /// severity colors keep tracking usage.
    case rails(identity: String, bars: [RailValue], remaining: Bool)
    /// Two stacked micro lines (window label over percent), iStat-style
    /// — emitted when both rail labels are on.
    case stack(top: String, bottom: String)
    /// Ledger history sparkline; `money` obeys privacy, `line` draws a
    /// polyline instead of bars (descriptor presentation).
    case spark(values: [Double], money: Bool, line: Bool)
    case placeholder
}

/// Rendering plus per-segment metric provenance so overflow folding
/// can tell what may fold (§6.5: quota, rails, freshness never fold).
public struct SegmentRendering {
    public let segments: [StatusSegment]
    public let metrics: [MenuItemMetric]
    public let tooltip: String
}

public let FOLDABLE_METRICS: Set<MenuItemMetric> = [
    .quotaReset, .consumedTokenHistory, .actualCostHistory,
    .providerLabel, .agentActive, .spacer,
]

/// Which trailing segments to fold into `+N` when the track is over
/// budget. Pure: widths are measured by the caller. Only foldable
/// metrics fold, from the end, and the saved order never changes.
public func foldSegmentIndices(
    metrics: [MenuItemMetric],
    widths: [Double],
    budget: Double,
    gap: Double,
    indicatorWidth: Double
) -> (visible: [Int], hiddenCount: Int) {
    precondition(metrics.count == widths.count)
    var visible = Array(metrics.indices)
    func totalWidth(extra: Double) -> Double {
        let sum = visible.reduce(0.0) { $0 + widths[$1] }
        let joints = Double(max(0, visible.count - (extra > 0 ? 0 : 1)))
        return sum + joints * gap + extra
    }
    if totalWidth(extra: 0) <= budget { return (visible, 0) }

    var hidden = 0
    for index in metrics.indices.reversed() {
        guard FOLDABLE_METRICS.contains(metrics[index]) else { continue }
        visible.removeAll { $0 == index }
        hidden += 1
        if totalWidth(extra: indicatorWidth) <= budget { break }
    }
    return (visible, hidden)
}

public struct RailValue: Equatable {
    public let windowId: String
    public let usedPercent: Double

    public init(windowId: String, usedPercent: Double) {
        self.windowId = windowId
        self.usedPercent = usedPercent
    }
}

/// Full catalog rendering: text metrics reuse the text renderer's
/// rules; graphical metrics (rails, history sparks) become drawable
/// segments fed by quota windows and ledger day buckets.
public func renderStatusSegments(
    descriptors: [MenuItemDescriptor],
    quota: [QuotaSnapshotDTO],
    buckets: [ReportBucketDTO],
    activeAccounts: [String: String?],
    hourBuckets: [ReportBucketDTO] = [],
    todayAgentRows: [String: Int]? = nil,
    privacy: Bool = false,
    nominalCost: Bool = false,
    now: Date = Date()
) -> SegmentRendering {
    var segments: [StatusSegment] = []
    var metrics: [MenuItemMetric] = []
    var tooltip: [String] = []
    let names = PrivacyNames(privacy: privacy, quota: quota)

    func append(_ segment: StatusSegment, _ metric: MenuItemMetric) {
        segments.append(segment)
        metrics.append(metric)
    }
    /// "icon" identity becomes a drawable glyph segment; privacy keeps
    /// the neutral alias text instead (a glyph would identify).
    func wantsGlyph(_ descriptor: MenuItemDescriptor) -> Bool {
        (descriptor.providerIdentityPresentation ?? "icon") == "icon" && !privacy
    }
    func withoutIdentity(_ descriptor: MenuItemDescriptor) -> MenuItemDescriptor {
        var copy = descriptor
        copy.providerIdentityPresentation = "none"
        return copy
    }

    var rowsByAgent: [String: AgentAttention] = [:]
    for snapshot in quota {
        let candidate = attention(for: snapshot, now: now)
        let activeId = activeAccounts[snapshot.agent] ?? nil
        if let existing = rowsByAgent[snapshot.agent] {
            let existingIsActive = existing.snapshot.accountId != nil && existing.snapshot.accountId == activeId
            let candidateIsActive = candidate.snapshot.accountId != nil && candidate.snapshot.accountId == activeId
            if candidateIsActive || (!existingIsActive && candidate.rank < existing.rank) {
                rowsByAgent[snapshot.agent] = candidate
            }
        } else {
            rowsByAgent[snapshot.agent] = candidate
        }
    }
    let rows = Array(rowsByAgent.values)
    let recentBuckets = Array(buckets.suffix(7))

    for descriptor in descriptors {
        switch descriptor.metric {
        case .quotaMiniBar:
            guard let resolved = resolveQuotaBinding(descriptor, rows: rows),
                  let bars = railBars(descriptor, item: resolved.0, resolvedWindow: resolved.1) else {
                if descriptor.unavailableBehavior == "placeholder" { append(.placeholder, descriptor.metric) }
                tooltip.append("rails: window not returned by the source")
                continue
            }
            let item = resolved.0
            let direction = descriptor.direction ?? "used"
            let remaining = direction == "remaining"
            func displayPercent(_ bar: RailValue) -> Int {
                remaining ? 100 - Int(bar.usedPercent.rounded()) : Int(bar.usedPercent.rounded())
            }
            if wantsGlyph(descriptor) {
                append(.glyph(agent: item.snapshot.agent), descriptor.metric)
                append(.rails(identity: "", bars: bars, remaining: remaining), descriptor.metric)
            } else {
                append(.rails(
                    identity: identityText(descriptor, code: names.code(item.snapshot.agent)),
                    bars: bars, remaining: remaining), descriptor.metric)
            }
            // visible labels: both on = an iStat-style two-line stack
            // per bar; a single toggle stays one centered line
            let wantLabel = descriptor.showWindowLabel ?? true
            let wantPercent = descriptor.showPercentage ?? true
            if wantLabel && wantPercent {
                for bar in bars {
                    append(.stack(top: shortWindowLabel(bar.windowId),
                                  bottom: "\(displayPercent(bar))%"), descriptor.metric)
                }
            } else if wantLabel {
                append(.text(bars.map { shortWindowLabel($0.windowId) }.joined(separator: " ")),
                       descriptor.metric)
            } else if wantPercent {
                append(.text(bars.map { "\(displayPercent($0))%" }.joined(separator: " ")),
                       descriptor.metric)
            }
            for bar in bars {
                tooltip.append(
                    "\(names.display(item.snapshot.agent)) \(bar.windowId) \(direction) "
                    + "\(displayPercent(bar))% · \(names.account(item.snapshot.account))")
            }
        case .consumedTokenHistory, .actualCostHistory:
            let money = descriptor.metric == .actualCostHistory
            if money && privacy {
                // costs neutralize under privacy — no spark, no number
                if descriptor.unavailableBehavior == "placeholder" { append(.placeholder, descriptor.metric) }
                tooltip.append("cost history: Private metric hidden")
                continue
            }
            // the range picks its bucket grain: 5h/24h ride hour
            // buckets, 7d rides day buckets — never resampled guesses
            let source: [ReportBucketDTO]
            let rangeLabel: String
            switch descriptor.timeRange {
            case "last_5h":
                source = Array(hourBuckets.suffix(5)); rangeLabel = "5h"
            case "last_24h":
                source = Array(hourBuckets.suffix(24)); rangeLabel = "24h"
            default:
                // 7d prefers hour grain (~168 points) so a longer range
                // reads denser in the same fixed track width
                source = hourBuckets.count >= 8
                    ? Array(hourBuckets.suffix(168))
                    : recentBuckets
                rangeLabel = "7d"
            }
            let values = source.map { bucket in
                if !money {
                    return bucket.tokens.inputTokens + bucket.tokens.outputTokens
                }
                // the spark follows the same cost mode as the Today
                // cards — Nominal never silently reverts to Actual
                let cost = nominalCost ? (bucket.nominal ?? bucket.actual) : bucket.actual
                return cost.usd ?? cost.pricedSubtotalUsd
            }
            if values.count < 2 {
                // one sample is a snapshot, never a trend
                if descriptor.unavailableBehavior == "placeholder" { append(.placeholder, descriptor.metric) }
                tooltip.append("history: not enough \(rangeLabel) buckets")
                continue
            }
            append(.spark(values: values, money: money,
                          line: descriptor.presentation == "line"), descriptor.metric)
            tooltip.append(money
                ? "Actual cost, last \(rangeLabel) (\(values.count) buckets)"
                : "Consumed tokens, last \(rangeLabel) (\(values.count) buckets)")
        case .agentActive:
            // ledger activity, not quota. nil = no reading yet
            // (placeholder); an empty map is a real "0 act".
            guard let todayAgentRows else {
                if descriptor.unavailableBehavior == "placeholder" { append(.placeholder, descriptor.metric) }
                tooltip.append("agent activity: no ledger reading yet")
                continue
            }
            let active = todayAgentRows.filter { $0.value > 0 }
            append(.text("\(active.count) act"), descriptor.metric)
            for (agent, rowCount) in active.sorted(by: { $0.key < $1.key }) {
                tooltip.append("\(names.display(agent)): \(rowCount) prompts today")
            }
        case .quotaUsagePercentage where wantsGlyph(descriptor):
            // glyph identity: drawable glyph + the text renderer's own
            // output minus its identity code
            guard let resolved = resolveQuotaBinding(descriptor, rows: rows) else {
                if descriptor.unavailableBehavior == "placeholder" { append(.placeholder, descriptor.metric) }
                tooltip.append("quota: window not returned by the source")
                continue
            }
            append(.glyph(agent: resolved.0.snapshot.agent), descriptor.metric)
            let rendering = renderStatusItems(
                descriptors: [withoutIdentity(descriptor)], quota: quota,
                activeAccounts: activeAccounts, privacy: privacy, now: now)
            if rendering.title != "tally" && !rendering.title.isEmpty {
                append(.text(rendering.title), descriptor.metric)
            }
            if !rendering.tooltip.isEmpty { tooltip.append(rendering.tooltip) }
        case .providerLabel where wantsGlyph(descriptor):
            if case .provider(let provider) = descriptor.scope {
                append(.glyph(agent: provider), descriptor.metric)
            } else if case .pin(let provider, _) = descriptor.binding {
                append(.glyph(agent: provider), descriptor.metric)
            }
        default:
            // text metrics share the text renderer's exact rules
            let rendering = renderStatusItems(
                descriptors: [descriptor], quota: quota,
                activeAccounts: activeAccounts, privacy: privacy, now: now)
            if rendering.title != "tally" && !rendering.title.isEmpty {
                append(.text(rendering.title), descriptor.metric)
            }
            if !rendering.tooltip.isEmpty {
                tooltip.append(rendering.tooltip)
            }
        }
    }
    return SegmentRendering(segments: segments, metrics: metrics,
                            tooltip: tooltip.joined(separator: "\n"))
}

/// 1st window (required) + optional 2nd window. The legacy fixed pair
/// (5h+7d) still renders when no explicit 2nd window is saved. Missing
/// windows are nil, never 0%.
private func railBars(
    _ descriptor: MenuItemDescriptor,
    item: AgentAttention,
    resolvedWindow: QuotaWindowDTO?
) -> [RailValue]? {
    let windows = item.snapshot.windows
    if let secondId = descriptor.secondNativeWindowId {
        guard let first = resolvedWindow else { return nil }
        var bars = [RailValue(windowId: first.id, usedPercent: first.usedPercent)]
        // the optional 2nd rail drops when its window vanished — the
        // 1st stays; a vanished id is never fuzzy-matched
        if secondId != first.id,
           let second = windows.first(where: { $0.id == secondId }) {
            bars.append(RailValue(windowId: second.id, usedPercent: second.usedPercent))
        }
        return bars
    }
    if descriptor.windowSet == "pair" {
        let fiveHour = windows.first { shortWindowLabel($0.id) == "5h" }
        let sevenDay = windows.first { shortWindowLabel($0.id) == "7d" }
        guard let fiveHour, let sevenDay else { return nil }
        return [
            RailValue(windowId: fiveHour.id, usedPercent: fiveHour.usedPercent),
            RailValue(windowId: sevenDay.id, usedPercent: sevenDay.usedPercent),
        ]
    }
    guard let window = resolvedWindow else { return nil }
    return [RailValue(windowId: window.id, usedPercent: window.usedPercent)]
}

/// Whether the provider currently returns both a 5h and a 7d window —
/// the Builder disables the pair option (with a reason) otherwise.
public func supportsPairWindows(agent: String, quota: [QuotaSnapshotDTO]) -> Bool {
    let windows = quota.filter { $0.agent == agent }.flatMap(\.windows)
    return windows.contains { shortWindowLabel($0.id) == "5h" }
        && windows.contains { shortWindowLabel($0.id) == "7d" }
}

/// Name resolution under privacy: real names normally, session-stable
/// `P1/P2…` and `Account hidden` when privacy is on — in the visible
/// text and in tooltips alike.
struct PrivacyNames {
    private let privacy: Bool
    private let aliases: [String: String]

    init(privacy: Bool, quota: [QuotaSnapshotDTO]) {
        self.privacy = privacy
        self.aliases = privacy ? privacyAliases(for: quota) : [:]
    }

    func code(_ agent: String) -> String {
        privacy ? (aliases[agent] ?? "P?") : agentShortCode(agent)
    }

    func display(_ agent: String) -> String {
        privacy ? (aliases[agent] ?? "Provider") : agentDisplayName(agent)
    }

    func account(_ account: String?) -> String {
        privacy ? "Account hidden" : (account ?? "unknown account")
    }
}
