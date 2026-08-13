# @llmtally/app

The macOS menubar app — local preview stage. The Swift shell renders a
descriptor-driven status item, an Overview/Provider popover with account
switching, a Builder + Settings window, and threshold notifications; a
Bun sidecar speaks JSON-RPC to @llmtally/core. Not yet notarized — the
TUI remains the canonical surface for investigation.

Design canon: `local_docs/mac_menubar_app_init/` (01_plan §9 fixes the
architecture: SwiftUI + AppKit `NSStatusItem` + Bun sidecar).

## Layout

```text
packages/app/
├── src/
│   ├── rpc.ts            JSON-RPC 2.0 framing (newline-delimited stdio)
│   ├── api.ts            method handlers binding @llmtally/core
│   └── sidecar-main.ts   sidecar entry (`bun src/sidecar-main.ts`)
├── macos/                SwiftPM package
│   ├── Sources/LLMTallyKit/     pure logic — DTOs, attention ranking,
│   │                            menuBarBuilderV1 descriptors, status renderer
│   ├── Sources/LLMTallyBar/     the app — NSStatusItem + popover
│   │                            (Overview / provider detail / switch sheet)
│   └── Sources/KitSelftest/     `swift run kit-selftest` — assert-based
│                                checks (XCTest needs a licensed Xcode)
└── assets/               AppIcon.icns + 1024 master (00_fixed_dark)
```

The shell never opens SQLite or the vault. Every data question goes
through the sidecar, which consumes `@llmtally/core` directly — the
same domain layer the TUI uses, so there is exactly one source of truth
for parsing, quota, and the switch transaction.

## Run (dev checkout)

```bash
cd packages/app/macos && swift build && .build/debug/LLMTallyBar
swift run kit-selftest    # headless checks for LLMTallyKit
```

Or as a real bundle (unlocks the app icon, notifications, launch at
login — all gated on a bundle identifier):

```bash
sh packages/app/scripts/bundle.sh && open packages/app/build/LLMTally.app
```

The bundle is self-contained: `bun build --compile` embeds the sidecar
as a single binary in `Contents/Helpers/llmtally-sidecar`, so a
bundled app needs neither a bun install nor this checkout. Resolution
order: `LLMTALLY_SIDECAR` (TypeScript via bun, dev override) → the
embedded helper → the checkout's `src/sidecar-main.ts` via a probed
bun (`LLMTALLY_BUN` override) for unbundled dev binaries.

The status item renders the user's ordered `MenuItemDescriptor[]`
(`menuBarBuilderV1` in UserDefaults, Auto-seeded on first run) against
live quota every 15 minutes; the popover and the status text share the
same attention ranking and the same sidecar.

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
