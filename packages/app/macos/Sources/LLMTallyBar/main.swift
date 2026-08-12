import AppKit

// Menubar-only app: no Dock icon, no main window. The status item is the app.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
