import Foundation
import LLMTallyKit
import UserNotifications

/// Delivers what the pure planner decided. All once-per-crossing logic
/// lives in LLMTallyKit; this class only persists the planner state and
/// hands text to UNUserNotificationCenter.
///
/// An unbundled dev binary (plain SwiftPM executable) has no bundle
/// identifier and UserNotifications refuses to work — in that case the
/// planner still runs (state stays correct) and deliveries go to
/// stderr instead of crashing.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()
    private static let stateKey = "notificationStateV1"

    private var canDeliver: Bool { Bundle.main.bundleIdentifier != nil }

    func requestAuthorizationIfNeeded() {
        guard canDeliver else { return }
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Clicking a notification opens the popover (03_design_spec §10).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // only the default click opens the popover — dismissals and
        // future custom actions must not
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .llmtallyOpenPopover, object: nil)
            }
        }
        completionHandler()
    }

    func process(quota: [QuotaSnapshotDTO], privacy: Bool) {
        let result = planNotifications(state: loadState(), quota: quota, privacy: privacy)
        saveState(result.state)

        guard !result.notifications.isEmpty else { return }
        guard canDeliver else {
            for notification in result.notifications {
                FileHandle.standardError.write(
                    Data("notification (unbundled, skipped): \(notification.title)\n".utf8))
            }
            return
        }
        for notification in result.notifications {
            let content = UNMutableNotificationContent()
            content.title = notification.title
            content.body = notification.body
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: notification.key, content: content, trigger: nil))
        }
    }

    private func loadState() -> NotificationState {
        guard
            let data = UserDefaults.standard.data(forKey: Self.stateKey),
            let state = try? JSONDecoder().decode(NotificationState.self, from: data)
        else { return NotificationState() }
        return state
    }

    private func saveState(_ state: NotificationState) {
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: Self.stateKey)
        }
    }
}
