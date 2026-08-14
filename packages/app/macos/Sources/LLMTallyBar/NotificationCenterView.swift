import SwiftUI
import LLMTallyKit

extension Notification.Name {
    /// Posted by NotificationManager after folding a planner tick into
    /// the in-app log, so an open popover updates its bell immediately.
    static let llmtallyNotificationLogChanged = Notification.Name("llmtallyNotificationLogChanged")
}

/// App-lifetime view of the persisted notification log
/// (06_notification_center_design §5). All rules live in LLMTallyKit's
/// pure fold functions; this object only persists and republishes.
final class NotificationCenterModel: ObservableObject {
    static let shared = NotificationCenterModel()
    private let store = NotificationLogStore()

    @Published private(set) var log = NotificationLogState()

    private init() {
        log = store.load()
        NotificationCenter.default.addObserver(
            forName: .llmtallyNotificationLogChanged, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.log = self.store.load()
        }
    }

    var unreadCount: Int { unreadNotifications(log).count }
    var worstUnread: NotificationSeverity? { worstUnreadSeverity(log) }
    var hasDismissable: Bool { log.events.contains(\.isDismissable) }

    /// Leaving the panel is what reads the rows (the badge already went
    /// out when it opened) — GitHub/Slack convention from the 시안.
    func markAllRead() {
        log = logMarkingAllRead(log)
        store.save(log)
    }

    func dismiss(id: String) {
        log = logDismissing(log, id: id)
        store.save(log)
    }

    func clearAll() {
        log = logClearingAll(log)
        store.save(log)
    }
}

private extension Sequence {
    func contains(_ keyPath: KeyPath<Element, Bool>) -> Bool {
        contains { $0[keyPath: keyPath] }
    }
}

/// The bell button for the popover header: outline bell plus the
/// unread dot whose color is the worst unread severity.
struct NotificationBellButton: View {
    @ObservedObject var center: NotificationCenterModel
    let isOpen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell")
                if !isOpen, let severity = center.worstUnread {
                    Circle()
                        .fill(severity == .actNow ? Theme.current().crit : Theme.current().warn)
                        .frame(width: 6, height: 6)
                        .offset(x: 2, y: -1)
                }
            }
        }
        .buttonStyle(HoverActionButtonStyle())
        .help(center.unreadCount > 0
              ? "Notifications · \(center.unreadCount) unread"
              : "Notifications")
        .accessibilityLabel(center.unreadCount > 0
                            ? "Notifications, \(center.unreadCount) unread"
                            : "Notifications")
    }
}

/// The bell's list view (시안 prototypes/notifications.html): TODAY /
/// EARLIER groups, hover ✕ per row, act-now rows locked until resolved,
/// row click deep-links into the provider.
struct NotificationCenterView: View {
    @ObservedObject var center: NotificationCenterModel
    var privacy = false
    let onOpenAgent: (String) -> Void
    @State private var hoveredId: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if center.log.events.isEmpty {
                    emptyState
                } else {
                    let (today, earlier) = grouped()
                    if !today.isEmpty {
                        groupHeader("TODAY")
                        ForEach(today) { row($0) }
                    }
                    if !earlier.isEmpty {
                        groupHeader("EARLIER")
                        ForEach(earlier) { row($0) }
                    }
                    Text("Click a row to open its provider · 14-day retention · macOS alerts in Settings")
                        .font(.system(size: 10)).foregroundStyle(.tertiary)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .reportsPanelContentHeight()
        }
    }

    /// Newest first inside each group; the calendar day splits them.
    private func grouped() -> ([LoggedNotification], [LoggedNotification]) {
        let todayKey = localDayKey()
        let sorted = center.log.events.sorted { $0.createdAtUtc > $1.createdAtUtc }
        let today = sorted.filter { localDayKey(Date(timeIntervalSince1970: $0.createdAtUtc)) == todayKey }
        let earlier = sorted.filter { localDayKey(Date(timeIntervalSince1970: $0.createdAtUtc)) != todayKey }
        return (today, earlier)
    }

    private func groupHeader(_ label: String) -> some View {
        Text(label)
            .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 2)
    }

    private func row(_ event: LoggedNotification) -> some View {
        let theme = Theme.current()
        let aliasesNow = privacy
            ? privacyAliases(for: OverviewModel.shared.overview?.quota ?? [])
            : [:]
        let title = privacy
            ? redactedTitle(event, aliases: aliasesNow)
            : event.title
        return HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(event.isUnread
                      ? (event.severity == .actNow ? theme.crit : theme.warn)
                      : Color.clear)
                .overlay(Circle().strokeBorder(
                    event.isUnread ? Color.clear : Color.secondary.opacity(0.5), lineWidth: 1))
                .frame(width: 7, height: 7)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.system(size: 12, weight: event.isUnread ? .semibold : .regular))
                        .foregroundStyle(event.isUnread ? .primary : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if event.resolvedAtUtc != nil {
                        Text("resolved").font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(theme.live)
                    }
                }
                Text("\(event.body) · \(timestamp(event.createdAtUtc))")
                    .font(.system(size: 10.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                center.dismiss(id: event.id)
            } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
            }
            .buttonStyle(HoverActionButtonStyle())
            .disabled(!event.isDismissable)
            .opacity(hoveredId == event.id ? (event.isDismissable ? 1 : 0.3) : 0)
            .help(event.isDismissable ? "Dismiss" : "Unresolved — clears when fixed")
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .contentShape(Rectangle())
        .background(hoveredId == event.id ? Color.primary.opacity(0.05) : .clear)
        .onHover { hovering in hoveredId = hovering ? event.id : (hoveredId == event.id ? nil : hoveredId) }
        .onTapGesture { onOpenAgent(event.agent) }
    }

    /// Privacy mode replaces the provider display name the planner put
    /// first in every title; bodies never carry identities to begin with.
    private func redactedTitle(_ event: LoggedNotification, aliases: [String: String]) -> String {
        let alias = aliases[event.agent] ?? "Provider"
        guard let dash = event.title.range(of: " — ") else { return alias }
        return alias + event.title[dash.lowerBound...]
    }

    private func timestamp(_ epoch: Double) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = localDayKey(Date(timeIntervalSince1970: epoch)) == localDayKey()
            ? "HH:mm" : "MM-dd HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: epoch))
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "bell").font(.system(size: 20)).foregroundStyle(.tertiary)
            Text("No notifications").font(.callout)
            Text("Threshold crossings and freshness episodes land here and in macOS alerts.")
                .font(.caption).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34).padding(.horizontal, 20)
    }
}
