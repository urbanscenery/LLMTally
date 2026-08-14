import Foundation

/// Attention ranking (03_design_spec §2): permission and freshness
/// outrank percentages. The headline, the row order, and the status
/// item's follow-attention binding all use this; the number itself is
/// never the first thing shown when something above it is wrong.
public enum AttentionRank: Int, Comparable {
    case authInvalid = 0
    /// Split-brain: the config's selected account and the live
    /// credential's owner disagree — right below auth because the fix
    /// is also a user action (quit the stale session, switch again).
    case accountMismatch = 1
    case rateLimited = 2
    case stale = 3
    case critical = 4
    case warning = 5
    case resetSoon = 6
    case quiet = 7

    public static func < (lhs: AttentionRank, rhs: AttentionRank) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

/// Snapshots older than this are stale. Placeholder for "source cadence
/// × 2" until per-source cadence is part of the payload.
public let STALE_AFTER_SECONDS: Double = 1800
public let RESET_SOON_SECONDS: Double = 1800

/// User-configurable quota thresholds (Settings → Thresholds). The
/// defaults are the spec's 70/90; ranking, rails, and the notification
/// planner all read the same values.
public enum QuotaThresholds {
    public static var warning: Double = 70
    public static var critical: Double = 90
}

public var CRITICAL_USED_PERCENT: Double { QuotaThresholds.critical }
public var WARNING_USED_PERCENT: Double { QuotaThresholds.warning }

public struct AgentAttention {
    public let snapshot: QuotaSnapshotDTO
    public let rank: AttentionRank
    /// The window driving the rank — the row's big number.
    public let topWindow: QuotaWindowDTO?
}

public func attention(for snapshot: QuotaSnapshotDTO, now: Date = Date()) -> AgentAttention {
    let topWindow = snapshot.windows.max(by: { $0.usedPercent < $1.usedPercent })

    if snapshot.failure?.kind == "auth_invalid" {
        return AgentAttention(snapshot: snapshot, rank: .authInvalid, topWindow: topWindow)
    }
    if snapshot.failure?.kind == "account_mismatch" {
        return AgentAttention(snapshot: snapshot, rank: .accountMismatch, topWindow: topWindow)
    }
    if snapshot.failure?.kind == "rate_limited" {
        return AgentAttention(snapshot: snapshot, rank: .rateLimited, topWindow: topWindow)
    }
    // Age gates every source that mirrors a live gauge — a 2-hour-old
    // stored_history reading posing as fresh is exactly the trust bug
    // the rank exists to surface (audit CX-48). Only local_logs stays
    // exempt: an idle agent's last log event is old by definition.
    let age = now.timeIntervalSince1970 - epochSeconds(snapshot.observedAtUtc)
    let agedSources: Set<String> = ["vendor_api", "stored_history", "third_party_cache"]
    if agedSources.contains(snapshot.source) && age > STALE_AFTER_SECONDS {
        return AgentAttention(snapshot: snapshot, rank: .stale, topWindow: topWindow)
    }
    if let topWindow {
        if topWindow.usedPercent >= CRITICAL_USED_PERCENT {
            return AgentAttention(snapshot: snapshot, rank: .critical, topWindow: topWindow)
        }
        if topWindow.usedPercent >= WARNING_USED_PERCENT {
            return AgentAttention(snapshot: snapshot, rank: .warning, topWindow: topWindow)
        }
    }
    let resetSoon = snapshot.windows.first { window in
        guard let resets = window.resetsAtUtc else { return false }
        let remaining = epochSeconds(resets) - now.timeIntervalSince1970
        return remaining > 0 && remaining <= RESET_SOON_SECONDS && window.usedPercent >= 50
    }
    if let resetSoon {
        return AgentAttention(snapshot: snapshot, rank: .resetSoon, topWindow: resetSoon)
    }
    return AgentAttention(snapshot: snapshot, rank: .quiet, topWindow: topWindow)
}

/// Act-now ranks keep the popover headline until resolved; everything
/// below them is a notice that lives in the bell
/// (06_notification_center_design §3).
public func isActNowRank(_ rank: AttentionRank) -> Bool {
    rank == .authInvalid || rank == .accountMismatch || rank == .critical
}

/// Highest-attention item; ties break toward the tighter window.
public func headlineAttention(_ items: [AgentAttention]) -> AgentAttention? {
    items.min { lhs, rhs in
        if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
        return (lhs.topWindow?.usedPercent ?? 0) > (rhs.topWindow?.usedPercent ?? 0)
    }
}
