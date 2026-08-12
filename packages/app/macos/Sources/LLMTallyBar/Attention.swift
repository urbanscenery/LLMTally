import Foundation

/// Attention ranking (03_design_spec §2): permission and freshness
/// outrank percentages. The headline and the row order both use this;
/// the number itself is never the first thing the user is shown when
/// something above it is wrong.
enum AttentionRank: Int, Comparable {
    case authInvalid = 0
    case rateLimited = 1
    case stale = 2
    case critical = 3
    case warning = 4
    case resetSoon = 5
    case quiet = 6

    static func < (lhs: AttentionRank, rhs: AttentionRank) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

/// Snapshots older than this are stale. Placeholder for "source cadence
/// × 2" until per-source cadence is part of the payload.
let STALE_AFTER_SECONDS: Double = 1800
let RESET_SOON_SECONDS: Double = 1800
let CRITICAL_USED_PERCENT: Double = 90
let WARNING_USED_PERCENT: Double = 70

struct AgentAttention {
    let snapshot: QuotaSnapshotDTO
    let rank: AttentionRank
    /// The window driving the rank — the row's big number.
    let topWindow: QuotaWindowDTO?
}

func attention(for snapshot: QuotaSnapshotDTO, now: Date = Date()) -> AgentAttention {
    let topWindow = snapshot.windows.max(by: { $0.usedPercent < $1.usedPercent })

    if snapshot.failure?.kind == "auth_invalid" {
        return AgentAttention(snapshot: snapshot, rank: .authInvalid, topWindow: topWindow)
    }
    if snapshot.failure?.kind == "rate_limited" {
        return AgentAttention(snapshot: snapshot, rank: .rateLimited, topWindow: topWindow)
    }
    let age = now.timeIntervalSince1970 - epochSeconds(snapshot.observedAtUtc)
    if snapshot.source == "vendor_api" && age > STALE_AFTER_SECONDS {
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

/// Highest-attention item; ties break toward the tighter window.
func headlineAttention(_ items: [AgentAttention]) -> AgentAttention? {
    items.min { lhs, rhs in
        if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
        return (lhs.topWindow?.usedPercent ?? 0) > (rhs.topWindow?.usedPercent ?? 0)
    }
}
