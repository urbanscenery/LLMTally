import AppKit
import LLMTallyKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusController: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Single instance: a login item plus a manual `open` would mean
        // two status items, two sidecars, and racing switch/detach
        // flows. The older instance wins; this one bows out.
        let bundleId = Bundle.main.bundleIdentifier
        if let bundleId,
           NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
               .contains(where: { $0 != NSRunningApplication.current }) {
            NSLog("llmtally is already running; exiting the duplicate instance")
            NSApp.terminate(nil)
            return
        }
        AppConfig.applyThresholds()
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
