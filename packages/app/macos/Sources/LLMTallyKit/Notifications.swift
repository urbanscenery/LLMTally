import Foundation

/// Notification planning (03_design_spec §10) as a pure state machine
/// so the once-per-crossing rules are testable without a delivery
/// framework:
/// - a threshold fires on the crossing event only; dropping back below
///   re-arms it (reset 후 재허용)
/// - auth-invalid fires immediately, once per episode
/// - stale fires once per episode
/// - bodies never contain an email, a prompt, or a token.
public struct PlannedNotification: Equatable {
    public let key: String
    public let agent: String
    public let title: String
    public let body: String
}

public struct NotificationState: Codable, Equatable {
    public var crossedThresholds: Set<String>
    public var authNotified: Set<String>
    public var staleNotified: Set<String>

    public init(crossedThresholds: Set<String> = [],
                authNotified: Set<String> = [],
                staleNotified: Set<String> = []) {
        self.crossedThresholds = crossedThresholds
        self.authNotified = authNotified
        self.staleNotified = staleNotified
    }
}

public func planNotifications(
    state: NotificationState,
    quota: [QuotaSnapshotDTO],
    privacy: Bool = false,
    now: Date = Date()
) -> (notifications: [PlannedNotification], state: NotificationState) {
    var next = state
    var planned: [PlannedNotification] = []
    let aliases = privacyAliases(for: quota)

    for snapshot in quota {
        let accountKey = "\(snapshot.agent)|\(snapshot.accountId ?? snapshot.account ?? "?")"
        let name = privacy
            ? (aliases[snapshot.agent] ?? "Provider")
            : agentDisplayName(snapshot.agent)

        // auth — immediate, once per episode; body names no email
        if snapshot.failure?.kind == "auth_invalid" {
            if !next.authNotified.contains(accountKey) {
                next.authNotified.insert(accountKey)
                planned.append(PlannedNotification(
                    key: "auth|\(accountKey)",
                    agent: snapshot.agent,
                    title: "\(name) — reconnect required",
                    body: "Live quota failed. Reconnect in Settings."))
            }
        } else {
            next.authNotified.remove(accountKey)
        }

        // stale — once per episode, for every source that mirrors a
        // live gauge (local_logs is exempt: idle agents' logs are old
        // by definition)
        let age = now.timeIntervalSince1970 - epochSeconds(snapshot.observedAtUtc)
        let agedSources: Set<String> = ["vendor_api", "stored_history", "third_party_cache"]
        if agedSources.contains(snapshot.source) && age > STALE_AFTER_SECONDS {
            if !next.staleNotified.contains(accountKey) {
                next.staleNotified.insert(accountKey)
                planned.append(PlannedNotification(
                    key: "stale|\(accountKey)",
                    agent: snapshot.agent,
                    title: "\(name) — quota is stale",
                    body: "No fresh reading for \(Int(STALE_AFTER_SECONDS / 60))+ minutes. Numbers are last-good, not live."))
            }
        } else {
            next.staleNotified.remove(accountKey)
        }

        // thresholds — crossing events only, re-armed below the line
        for window in snapshot.windows {
            // the configured thresholds ARE the state identity: after a
            // Settings change the old lines' arm state must not linger
            let criticalKey = "\(accountKey)|\(window.id)|\(Int(CRITICAL_USED_PERCENT))"
            let warningKey = "\(accountKey)|\(window.id)|\(Int(WARNING_USED_PERCENT))"

            if window.usedPercent >= CRITICAL_USED_PERCENT {
                if !next.crossedThresholds.contains(criticalKey) {
                    next.crossedThresholds.insert(criticalKey)
                    // a jump straight past both lines fires critical only
                    next.crossedThresholds.insert(warningKey)
                    planned.append(PlannedNotification(
                        key: "crit|\(criticalKey)",
                        agent: snapshot.agent,
                        title: "\(name) — \(shortWindowLabel(window.id)) \(Int(window.usedPercent.rounded()))% used",
                        body: "Critical threshold crossed. \(resetText(window.resetsAtUtc, now: now))."))
                }
            } else if window.usedPercent >= WARNING_USED_PERCENT {
                next.crossedThresholds.remove(criticalKey)
                if !next.crossedThresholds.contains(warningKey) {
                    next.crossedThresholds.insert(warningKey)
                    planned.append(PlannedNotification(
                        key: "warn|\(warningKey)",
                        agent: snapshot.agent,
                        title: "\(name) — \(shortWindowLabel(window.id)) \(Int(window.usedPercent.rounded()))% used",
                        body: "Warning threshold crossed. \(resetText(window.resetsAtUtc, now: now))."))
                }
            } else {
                // back under the line: both thresholds re-arm
                next.crossedThresholds.remove(criticalKey)
                next.crossedThresholds.remove(warningKey)
            }
        }
    }

    return (planned, next)
}

/// Session-stable neutral aliases for privacy mode: P1, P2, … assigned
/// by sorted agent id so the mapping is deterministic within a session
/// and across surfaces.
public func privacyAliases(for quota: [QuotaSnapshotDTO]) -> [String: String] {
    let agents = Array(Set(quota.map(\.agent))).sorted()
    var aliases: [String: String] = [:]
    for (index, agent) in agents.enumerated() {
        aliases[agent] = "P\(index + 1)"
    }
    return aliases
}
