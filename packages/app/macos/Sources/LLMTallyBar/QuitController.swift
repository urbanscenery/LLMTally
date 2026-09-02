import AppKit

/// The one quit path. A Switch holds Claude Code's lock protocol while
/// it runs; terminating mid-flight would leave the lock files behind
/// and skip the rollback, so every entry point (footer button, ⌘Q,
/// status-item menu) asks here, and AppDelegate refuses termination
/// while a switch is in flight.
enum QuitController {
    /// Set by SwitchSheet for the duration of its in-flight phase.
    /// Main-thread only.
    static var switchInFlight = false

    static var canQuit: Bool { !switchInFlight }

    /// Quits unless a switch is holding the lock. Returns false when
    /// refused so a caller can explain instead of silently doing nothing.
    @discardableResult
    static func requestQuit() -> Bool {
        guard canQuit else {
            NSLog("llmtally quit refused: a switch is holding the lock protocol")
            return false
        }
        NSApp.terminate(nil)
        return true
    }
}
