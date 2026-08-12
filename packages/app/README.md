# @llmtally/app

The macOS menubar app. Scaffold phase — the Swift shell, the Bun
sidecar seam, and the app icon exist; the real popover UI comes next.

Design canon: `local_docs/mac_menubar_app_init/` (01_plan §9 fixes the
architecture: SwiftUI + AppKit `NSStatusItem` + Bun sidecar).

## Layout

```text
packages/app/
├── src/
│   ├── rpc.ts            JSON-RPC 2.0 framing (newline-delimited stdio)
│   ├── api.ts            method handlers binding @llmtally/core
│   └── sidecar-main.ts   sidecar entry (`bun src/sidecar-main.ts`)
├── macos/                SwiftPM executable `LLMTallyBar`
│   └── Sources/LLMTallyBar/
│       ├── main.swift               accessory-policy NSApplication
│       ├── AppDelegate.swift        starts sidecar + status item
│       ├── StatusItemController.swift  tally template glyph + popover
│       ├── SidecarClient.swift      spawns bun, speaks JSON-RPC
│       └── OverviewView.swift       scaffold popover (raw payload)
└── assets/               AppIcon.icns + 1024 master (00_fixed_dark)
```

The shell never opens SQLite or the vault. Every data question goes
through the sidecar, which consumes `@llmtally/core` directly — the
same domain layer the TUI uses, so there is exactly one source of truth
for parsing, quota, and the switch transaction.

## Run (dev checkout)

```bash
cd packages/app/macos && swift build && .build/debug/LLMTallyBar
```

The shell resolves the sidecar at `packages/app/src/sidecar-main.ts`
relative to its own sources (override with `LLMTALLY_SIDECAR`), and
launches it via `/usr/bin/env bun` — dev-only; a bundled app ships its
own resolution.

The sidecar can be exercised alone:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"overview"}' | bun packages/app/src/sidecar-main.ts
```

## Protocol

Newline-delimited JSON-RPC 2.0 over stdio. Method surface and payload
shapes: `local_docs/mac_menubar_app_init/04_sidecar_contract.md`.

## Icon

`assets/AppIcon.icns` is generated from
`local_docs/mac_menubar_app_init/icons/00_fixed_dark.svg`
(qlmanage 1024 render → sips size ladder → iconutil). Regenerate the
same way if the SVG changes. The status-item glyph is separate by
design: a monochrome template tally drawn in code
(`StatusItemController.swift`).
