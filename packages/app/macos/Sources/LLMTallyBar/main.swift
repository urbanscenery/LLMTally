import AppKit

// A broken sidecar pipe must surface as a failed request, not kill the
// process: SIGPIPE's default action is silent termination, which left a
// ghost status item that vanished on click.
signal(SIGPIPE, SIG_IGN)

// Menubar-only app: no Dock icon, no main window. The status item is the app.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
