import Foundation

/// Notification planning (03_design_spec §10) as a pure state machine
/// so the once-per-crossing rules are testable without a delivery
/// framework:
/// - a threshold fires on the crossing event only; dropping back below
///   re-arms it (reset 후 재허용)
/// - auth-invalid / mismatch / rate-limited / stale fire once per episode
/// - reset-soon keys its episode on the reset instant itself, so the
///   next window naturally starts a new episode
/// - bodies never contain an email, a prompt, or a token.

/// Two tiers (06_notification_center_design §3): actNow keeps the
/// popover headline until resolved; notice lives in the bell only.
public enum NotificationSeverity: String, Codable {
    case actNow
    case notice
}

public struct PlannedNotification: Equatable {
    public let key: String
    public let agent: String
    public let severity: NotificationSeverity
    /// false = in-app bell only; the macOS banner set stays the
    /// original four (auth, stale, warning, critical crossings).
    public let systemBanner: Bool
    public let title: String
    public let body: String
}

public struct NotificationState: Codable, Equatable {
    public var crossedThresholds: Set<String>
    public var authNotified: Set<String>
    public var staleNotified: Set<String>
    public var mismatchNotified: Set<String>
    public var rateLimitedNotified: Set<String>
    public var noSubscriptionNotified: Set<String>
    /// Keys carry resetsAtUtc, so entries self-expire into new episodes.
    public var resetSoonNotified: Set<String>

    public init(crossedThresholds: Set<String> = [],
                authNotified: Set<String> = [],
                staleNotified: Set<String> = [],
                mismatchNotified: Set<String> = [],
                rateLimitedNotified: Set<String> = [],
                noSubscriptionNotified: Set<String> = [],
                resetSoonNotified: Set<String> = []) {
        self.crossedThresholds = crossedThresholds
        self.authNotified = authNotified
        self.staleNotified = staleNotified
        self.mismatchNotified = mismatchNotified
        self.rateLimitedNotified = rateLimitedNotified
        self.noSubscriptionNotified = noSubscriptionNotified
        self.resetSoonNotified = resetSoonNotified
    }

    /// Persisted states from before the notification-center rounds lack
    /// the newer sets; they decode as empty instead of failing.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        crossedThresholds = try container.decodeIfPresent(Set<String>.self, forKey: .crossedThresholds) ?? []
        authNotified = try container.decodeIfPresent(Set<String>.self, forKey: .authNotified) ?? []
        staleNotified = try container.decodeIfPresent(Set<String>.self, forKey: .staleNotified) ?? []
        mismatchNotified = try container.decodeIfPresent(Set<String>.self, forKey: .mismatchNotified) ?? []
        rateLimitedNotified = try container.decodeIfPresent(Set<String>.self, forKey: .rateLimitedNotified) ?? []
        noSubscriptionNotified = try container.decodeIfPresent(Set<String>.self, forKey: .noSubscriptionNotified) ?? []
        resetSoonNotified = try container.decodeIfPresent(Set<String>.self, forKey: .resetSoonNotified) ?? []
    }

    /// Every armed episode key, prefixed the way planned-notification
    /// keys are — the log marks an event resolved when its key leaves
    /// this set.
    public func activePlannedKeys() -> Set<String> {
        var keys = Set<String>()
        for k in authNotified { keys.insert("auth|\(k)") }
        for k in staleNotified { keys.insert("stale|\(k)") }
        for k in mismatchNotified { keys.insert("mismatch|\(k)") }
        for k in rateLimitedNotified { keys.insert("rate|\(k)") }
        for k in noSubscriptionNotified { keys.insert("nosub|\(k)") }
        for k in resetSoonNotified { keys.insert("resetsoon|\(k)") }
        for k in crossedThresholds {
            keys.insert("crit|\(k)")
            keys.insert("warn|\(k)")
        }
        return keys
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
                    severity: .actNow,
                    systemBanner: true,
                    title: "\(name) — reconnect required",
                    body: "Live quota failed. Reconnect in Settings."))
            }
        } else {
            next.authNotified.remove(accountKey)
        }

        // account mismatch — a user action fixes it (quit the stale
        // session, switch again); once per episode, bell only
        if snapshot.failure?.kind == "account_mismatch" {
            if !next.mismatchNotified.contains(accountKey) {
                next.mismatchNotified.insert(accountKey)
                planned.append(PlannedNotification(
                    key: "mismatch|\(accountKey)",
                    agent: snapshot.agent,
                    severity: .actNow,
                    systemBanner: false,
                    title: "\(name) — account mismatch",
                    body: "A running session reverted the switch. Quit it, then switch again."))
            }
        } else {
            next.mismatchNotified.remove(accountKey)
        }

        // rate limited — freshness notice, once per episode, bell only
        if snapshot.failure?.kind == "rate_limited" {
            if !next.rateLimitedNotified.contains(accountKey) {
                next.rateLimitedNotified.insert(accountKey)
                planned.append(PlannedNotification(
                    key: "rate|\(accountKey)",
                    agent: snapshot.agent,
                    severity: .notice,
                    systemBanner: false,
                    title: "\(name) — rate limited",
                    body: "Quota reads are throttled. Numbers are last-good, not live."))
            }
        } else {
            next.rateLimitedNotified.remove(accountKey)
        }

        // no subscription — a normal state the app otherwise renders as
        // healthy (2026-08-17), so the ONE banner on first detection is
        // the entire acknowledgement surface; after it, the row's
        // neutral "free plan" chip is all that remains
        if snapshot.failure?.kind == "no_subscription" {
            if !next.noSubscriptionNotified.contains(accountKey) {
                next.noSubscriptionNotified.insert(accountKey)
                planned.append(PlannedNotification(
                    key: "nosub|\(accountKey)",
                    agent: snapshot.agent,
                    severity: .notice,
                    systemBanner: true,
                    title: "\(name) — free plan",
                    body: "This account has no active subscription, so there is no usage quota to read. The app treats this as normal."))
            }
        } else {
            next.noSubscriptionNotified.remove(accountKey)
        }

        // stale — once per episode, for every source that mirrors a
        // live gauge (local_logs is exempt: idle agents' logs are old
        // by definition; free-plan rows are exempt too — no fresh gauge
        // will ever arrive for them, so aging is their normal state)
        let age = now.timeIntervalSince1970 - epochSeconds(snapshot.observedAtUtc)
        let agedSources: Set<String> = ["vendor_api", "stored_history", "third_party_cache"]
        if snapshot.failure?.kind != "no_subscription"
            && agedSources.contains(snapshot.source) && age > STALE_AFTER_SECONDS {
            if !next.staleNotified.contains(accountKey) {
                next.staleNotified.insert(accountKey)
                planned.append(PlannedNotification(
                    key: "stale|\(accountKey)",
                    agent: snapshot.agent,
                    severity: .notice,
                    systemBanner: true,
                    title: "\(name) — quota is stale",
                    body: "No fresh reading for \(Int(STALE_AFTER_SECONDS / 60))+ minutes. Numbers are last-good, not live."))
            }
        } else {
            next.staleNotified.remove(accountKey)
        }

        // reset-soon — the 06-design reframing of the old headline rule:
        // a window at ≥50% whose reset lands inside 30 minutes. The
        // reset instant is part of the key, so the episode expires with
        // the window and the next one can fire again. Bell only.
        for window in snapshot.windows {
            guard let resets = window.resetsAtUtc else { continue }
            let remaining = epochSeconds(resets) - now.timeIntervalSince1970
            guard remaining > 0, remaining <= RESET_SOON_SECONDS, window.usedPercent >= 50 else { continue }
            let resetKey = "\(accountKey)|\(window.id)|\(Int(epochSeconds(resets)))"
            if !next.resetSoonNotified.contains(resetKey) {
                next.resetSoonNotified.insert(resetKey)
                planned.append(PlannedNotification(
                    key: "resetsoon|\(resetKey)",
                    agent: snapshot.agent,
                    severity: .notice,
                    systemBanner: false,
                    title: "\(name) — \(shortWindowLabel(window.id)) resets in \(shortDuration(remaining)) · \(Int(window.usedPercent.rounded()))% used",
                    body: "Headroom expires with the reset."))
            }
        }
        // expired reset instants leave the set so future windows re-arm
        next.resetSoonNotified = next.resetSoonNotified.filter { key in
            guard let stamp = key.split(separator: "|").last, let at = Double(stamp) else { return false }
            return at > now.timeIntervalSince1970
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
                        severity: .actNow,
                        systemBanner: true,
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
                        severity: .notice,
                        systemBanner: true,
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
