import AppKit
import LLMTallyKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusController: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Single instance: a login item plus a manual `open` would mean
        // two status items, two sidecars, and racing switch/detach
        // flows. The older instance wins; this one bows out.
        let bundleId = Bundle.main.bundleIdentifier
        if let bundleId {
            // deterministic winner: only the YOUNGER instance exits, so
            // two simultaneous launches cannot terminate each other
            // (audit C1-08)
            let me = NSRunningApplication.current
            let older = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
                .contains { $0 != me && $0.processIdentifier < me.processIdentifier }
            if older {
                NSLog("llmtally is already running; exiting the duplicate instance")
                NSApp.terminate(nil)
                return
            }
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
