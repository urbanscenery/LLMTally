import AppKit
import LLMTallyKit
import SwiftUI

extension Notification.Name {
    /// Posted by the Builder after persisting descriptor changes so the
    /// status item re-renders without waiting for the next quota tick.
    static let llmtallyDescriptorsChanged = Notification.Name("llmtallyDescriptorsChanged")
}

/// Settings lives in its own window (03_design_spec §1) — never inside
/// the popover. The Builder is a scene of this window.
final class SettingsWindowController {
    static let shared = SettingsWindowController()
    private var window: NSWindow?

    func show() {
        if window == nil {
            let hosting = NSHostingController(rootView: SettingsView())
            let window = NSWindow(contentViewController: hosting)
            window.title = "LLMTally Settings"
            window.setContentSize(NSSize(width: 860, height: 700))
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.isReleasedWhenClosed = false
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
    }
}

struct SettingsView: View {
    enum Pane: String, CaseIterable {
        case general = "General"
        case menubar = "Menu bar"
    }

    @State private var pane: Pane = .menubar
    @State private var showBuilder = false

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Pane.allCases, id: \.self) { candidate in
                    Button {
                        pane = candidate
                        showBuilder = false
                    } label: {
                        Text(candidate.rawValue)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(pane == candidate ? Color.accentColor.opacity(0.18) : .clear))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(8)
            .frame(width: 180)
            .background(Color.primary.opacity(0.03))

            Divider()

            Group {
                if showBuilder {
                    BuilderView(onBack: { showBuilder = false })
                } else {
                    switch pane {
                    case .general: GeneralPane()
                    case .menubar: MenuBarPane(onConfigure: { showBuilder = true })
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct GeneralPane: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("General").font(.title2.weight(.semibold))
            Text("The menubar app reads @llmtally/core through the sidecar. It never parses the TUI.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Launch at login")
                Spacer()
                Toggle("", isOn: .constant(false)).disabled(true)
            }
            Text("Available once the app ships as a bundle (SMAppService needs a bundle identifier).")
                .font(.caption2).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Open dashboard")
                Spacer()
                Button("Open TUI") { OpenTUI.launch() }
            }
        }
        .padding(20)
    }
}

private struct MenuBarPane: View {
    let onConfigure: () -> Void
    private let store = DescriptorStore()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Menu bar").font(.title2.weight(.semibold))
            Text("The ordered descriptor array in the Builder is the only canon for the status item. This page is a summary and an entrance — no second preview, no display-mode ghost control.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("Current items")
                Spacer()
                Text(summary).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text("Configure items")
                Spacer()
                Button("Open Builder") { onConfigure() }
            }
        }
        .padding(20)
    }

    private var summary: String {
        let items = store.load()
        return "\(items.count) item\(items.count == 1 ? "" : "s")"
    }
}

/// Investigate happens in the TUI. The popover hands off instead of
/// growing a second terminal (01_plan §2).
enum OpenTUI {
    static func launch() {
        let script = """
        tell application "Terminal"
            activate
            do script "llmtally"
        end tell
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }
}
