import Foundation

/// The in-app notification center's ledger (06_notification_center_design):
/// every planned notification lands here regardless of macOS alert
/// authorization, so a denied banner is postponed into the bell instead
/// of muted forever. Pure fold functions keep the rules testable from
/// kit-selftest; `NotificationLogStore` only persists.

public struct LoggedNotification: Codable, Equatable, Identifiable {
    /// Unique per firing; the episode `key` repeats across episodes.
    public let id: String
    public let key: String
    public let agent: String
    public let severity: NotificationSeverity
    public let title: String
    public let body: String
    public let createdAtUtc: Double
    public var readAtUtc: Double?
    public var resolvedAtUtc: Double?

    public init(id: String, key: String, agent: String, severity: NotificationSeverity,
                title: String, body: String, createdAtUtc: Double,
                readAtUtc: Double? = nil, resolvedAtUtc: Double? = nil) {
        self.id = id
        self.key = key
        self.agent = agent
        self.severity = severity
        self.title = title
        self.body = body
        self.createdAtUtc = createdAtUtc
        self.readAtUtc = readAtUtc
        self.resolvedAtUtc = resolvedAtUtc
    }

    public var isUnread: Bool { readAtUtc == nil }
    /// Act-now rows lock their ✕ until the condition clears — the bell
    /// must not hide a problem that still needs the user.
    public var isDismissable: Bool { severity == .notice || resolvedAtUtc != nil }
}

public struct NotificationLogState: Codable, Equatable {
    public var events: [LoggedNotification]

    public init(events: [LoggedNotification] = []) {
        self.events = events
    }
}

public let NOTIFICATION_LOG_RETENTION_SECONDS: Double = 14 * 86_400
public let NOTIFICATION_LOG_MAX_EVENTS = 50

/// One planner tick folded into the log: new firings append, events
/// whose episode left the planner state resolve (and auto-read — a
/// fixed problem no longer asks for attention), and retention prunes.
public func logAfterPlanning(
    _ state: NotificationLogState,
    planned: [PlannedNotification],
    activeKeys: Set<String>,
    now: Date = Date()
) -> NotificationLogState {
    var events = state.events
    let stamp = now.timeIntervalSince1970

    for item in planned {
        events.append(LoggedNotification(
            id: "\(item.key)#\(Int(stamp * 1000))",
            key: item.key,
            agent: item.agent,
            severity: item.severity,
            title: item.title,
            body: item.body,
            createdAtUtc: stamp))
    }

    events = events.map { event in
        guard event.resolvedAtUtc == nil, !activeKeys.contains(event.key) else { return event }
        var resolved = event
        resolved.resolvedAtUtc = stamp
        if resolved.readAtUtc == nil { resolved.readAtUtc = stamp }
        return resolved
    }

    events.removeAll { stamp - $0.createdAtUtc > NOTIFICATION_LOG_RETENTION_SECONDS }
    if events.count > NOTIFICATION_LOG_MAX_EVENTS {
        events = Array(events.suffix(NOTIFICATION_LOG_MAX_EVENTS))
    }
    return NotificationLogState(events: events)
}

public func unreadNotifications(_ state: NotificationLogState) -> [LoggedNotification] {
    state.events.filter(\.isUnread)
}

/// The bell dot's color follows the worst unread severity.
public func worstUnreadSeverity(_ state: NotificationLogState) -> NotificationSeverity? {
    let unread = unreadNotifications(state)
    if unread.isEmpty { return nil }
    return unread.contains { $0.severity == .actNow } ? .actNow : .notice
}

public func logMarkingAllRead(_ state: NotificationLogState, now: Date = Date()) -> NotificationLogState {
    let stamp = now.timeIntervalSince1970
    return NotificationLogState(events: state.events.map { event in
        guard event.readAtUtc == nil else { return event }
        var read = event
        read.readAtUtc = stamp
        return read
    })
}

/// Dismissal removes the row; the planner's armed episode key is what
/// keeps the same episode from re-appending on the next tick.
public func logDismissing(_ state: NotificationLogState, id: String) -> NotificationLogState {
    NotificationLogState(events: state.events.filter { !($0.id == id && $0.isDismissable) })
}

public func logClearingAll(_ state: NotificationLogState) -> NotificationLogState {
    NotificationLogState(events: state.events.filter { !$0.isDismissable })
}

/// UserDefaults persistence, mirroring DescriptorStore. SQLite is
/// observation data; UI-scoped logs live with the other UI state.
public final class NotificationLogStore {
    public static let storageKey = "notificationCenterV1"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> NotificationLogState {
        guard
            let data = defaults.data(forKey: Self.storageKey),
            let state = try? JSONDecoder().decode(NotificationLogState.self, from: data)
        else { return NotificationLogState() }
        return state
    }

    public func save(_ state: NotificationLogState) {
        if let data = try? JSONEncoder().encode(state) {
            defaults.set(data, forKey: Self.storageKey)
        }
    }
}
