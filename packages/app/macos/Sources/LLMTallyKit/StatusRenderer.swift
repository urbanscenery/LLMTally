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
    now: Date = Date()
) -> StatusRendering {
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
            renderQuotaPercent(descriptor, rows: rows, now: now,
                               segments: &segments, tooltip: &tooltipLines)
        case .sourceFreshness:
            renderFreshness(rows: rows, now: now, segments: &segments, tooltip: &tooltipLines)
        case .quotaReset:
            renderReset(descriptor, rows: rows, now: now, segments: &segments, tooltip: &tooltipLines)
        case .providerLabel:
            if case .provider(let provider) = descriptor.scope {
                segments.append(agentShortCode(provider))
            } else if case .pin(let provider, _) = descriptor.binding {
                segments.append(agentShortCode(provider))
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
        segments.append("\(identityText(descriptor, agent: item.snapshot.agent))!")
        tooltip.append("\(agentDisplayName(item.snapshot.agent)) auth invalid · reconnect required")
        return
    }

    guard let window else {
        if descriptor.unavailableBehavior == "placeholder" { segments.append("—") }
        tooltip.append("\(agentDisplayName(item.snapshot.agent)): no windows reported")
        return
    }

    let direction = descriptor.direction ?? "used"
    let percent = direction == "remaining"
        ? 100 - Int(window.usedPercent.rounded())
        : Int(window.usedPercent.rounded())

    var parts: [String] = []
    let identity = identityText(descriptor, agent: item.snapshot.agent)
    if !identity.isEmpty { parts.append(identity) }
    if descriptor.showWindowLabel ?? true { parts.append(shortWindowLabel(window.id)) }
    if descriptor.showPercentage ?? true { parts.append("\(percent)%") }
    segments.append(parts.joined(separator: " "))

    tooltip.append(
        "\(agentDisplayName(item.snapshot.agent)) \(window.id) \(direction) "
        + "\(Int(window.usedPercent.rounded()))% · \(resetText(window.resetsAtUtc, now: now))"
        + " · \(item.snapshot.account ?? "unknown account")")
}

private func renderFreshness(
    rows: [AgentAttention],
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
            "\(agentDisplayName(row.snapshot.agent)): \(row.snapshot.source), "
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
    let remaining = epochSeconds(window.resetsAtUtc ?? 0) - now.timeIntervalSince1970
    segments.append(remaining > 0 ? shortDuration(remaining) : "reset")
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

private func identityText(_ descriptor: MenuItemDescriptor, agent: String) -> String {
    switch descriptor.providerIdentityPresentation {
    case "none": return ""
    default: return agentShortCode(agent)
    }
}
