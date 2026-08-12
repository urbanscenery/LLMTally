import AppKit
import LLMTallyKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusController: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try SidecarClient.shared.start()
        } catch {
            // The popover shows the connection error; the status item must
            // still appear so the user can see something is wrong.
            NSLog("sidecar start failed: \(error)")
        }
        statusController = StatusItemController()
        NotificationManager.shared.requestAuthorizationIfNeeded()
    }

    func applicationWillTerminate(_ notification: Notification) {
        SidecarClient.shared.stop()
    }
}
