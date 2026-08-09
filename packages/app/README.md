# @llmtally/app

The macOS menubar app. Not implemented yet.

It will consume `@llmtally/core` directly — quota snapshots, the account
vault, and ledger reports — the same way `@llmtally/tui` does, so the
domain layer stays the single source of truth and the menubar never
shells out to the terminal app.

Planned surface:

- menubar gauge for the tightest quota window across accounts
- account switching from the menu (the `switchAccount` transaction)
- notification when a window crosses a threshold
- "open dashboard" launching `llmtally` in a terminal

Platform decision (Swift vs Tauri) is still open; see
`local_docs/init/05_next_steps.md`.
