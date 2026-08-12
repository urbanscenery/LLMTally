import Foundation
import LLMTallyKit

// Headless checks for LLMTallyKit — `swift run kit-selftest`.
// Plain asserts instead of XCTest so they run with Command Line Tools
// alone; exit code 1 on any failure.

var failures = 0

func expect(_ condition: Bool, _ label: String) {
    if condition {
        print("ok   - \(label)")
    } else {
        failures += 1
        print("FAIL - \(label)")
    }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
    if actual == expected {
        print("ok   - \(label)")
    } else {
        failures += 1
        print("FAIL - \(label): expected \(expected), got \(actual)")
    }
}

func snapshot(
    agent: String,
    accountId: String? = "acct",
    account: String? = "user@example.com",
    source: String = "vendor_api",
    observedAgo: Double = 30,
    windows: [QuotaWindowDTO] = [],
    failureKind: String? = nil,
    now: Date = Date()
) -> QuotaSnapshotDTO {
    QuotaSnapshotDTO(
        agent: agent,
        accountId: accountId,
        account: account,
        plan: nil,
        source: source,
        observedAtUtc: now.timeIntervalSince1970 - observedAgo,
        windows: windows,
        failure: failureKind.map { QuotaFailureDTO(kind: $0, failedAtUtc: nil, retryAtUtc: nil) },
        retryAfterSeconds: nil,
        warnings: [])
}

// MARK: attention ranking

do {
    // auth outranks a higher percent
    let codex = attention(for: snapshot(
        agent: "codex",
        windows: [QuotaWindowDTO(id: "primary (10080m)", usedPercent: 22, resetsAtUtc: nil)],
        failureKind: "auth_invalid"))
    let claude = attention(for: snapshot(
        agent: "claude-code",
        windows: [QuotaWindowDTO(id: "five_hour", usedPercent: 72, resetsAtUtc: nil)]))
    let headline = headlineAttention([claude, codex])
    expectEqual(headline?.snapshot.agent, "codex", "auth outranks higher percent in the headline")
    expectEqual(claude.rank, AttentionRank.warning, "72% used ranks warning")

    // an old vendor snapshot is stale; old stored_history is expected
    let stale = attention(for: snapshot(agent: "codex", observedAgo: 7200,
        windows: [QuotaWindowDTO(id: "primary (300m)", usedPercent: 5, resetsAtUtc: nil)]))
    expectEqual(stale.rank, AttentionRank.stale, "old vendor_api snapshot is stale")
    let stored = attention(for: snapshot(agent: "grok", source: "stored_history", observedAgo: 7200,
        windows: [QuotaWindowDTO(id: "weekly", usedPercent: 5, resetsAtUtc: nil)]))
    expectEqual(stored.rank, AttentionRank.quiet, "old stored_history is not 'stale live data'")
}

// MARK: status renderer

do {
    // follow-attention tracks the ranking, not the biggest number
    let quota = [
        snapshot(agent: "claude-code",
                 windows: [QuotaWindowDTO(id: "five_hour", usedPercent: 72, resetsAtUtc: nil)]),
        snapshot(agent: "codex",
                 windows: [QuotaWindowDTO(id: "primary (10080m)", usedPercent: 22, resetsAtUtc: nil)],
                 failureKind: "auth_invalid"),
    ]
    let follow = renderStatusItems(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .quotaUsagePercentage,
                                         direction: "used", binding: .followAttention)],
        quota: quota, activeAccounts: [:])
    expectEqual(follow.title, "CDX!", "follow-attention shows broken codex, not 72% claude")
    expect(follow.tooltip.contains("auth invalid"), "auth tooltip explains itself")
}

do {
    // pinned window renders code + label + percent; tooltip keeps native id
    let quota = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 33, resetsAtUtc: Date().timeIntervalSince1970 + 7200),
        QuotaWindowDTO(id: "seven_day", usedPercent: 12, resetsAtUtc: nil),
    ])]
    let pinned = renderStatusItems(
        descriptors: [MenuItemDescriptor(scope: .provider("claude-code"), metric: .quotaUsagePercentage,
                                         direction: "used",
                                         binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"))],
        quota: quota, activeAccounts: [:])
    expectEqual(pinned.title, "CLA 5h 33%", "pinned window renders code, label, percent")
    expect(pinned.tooltip.contains("five_hour"), "tooltip keeps the exact native id")
    expect(pinned.tooltip.contains("resets in"), "tooltip carries the reset")

    // remaining inverts the same sample; tooltip keeps the direction truth
    let remaining = renderStatusItems(
        descriptors: [MenuItemDescriptor(scope: .provider("claude-code"), metric: .quotaUsagePercentage,
                                         direction: "remaining", showWindowLabel: false,
                                         binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"))],
        quota: quota, activeAccounts: [:])
    expectEqual(remaining.title, "CLA 67%", "remaining is 100 - used of the same sample")
    expect(remaining.tooltip.contains("remaining 33%"), "tooltip states direction and raw percent")

    // a vanished pinned window is a placeholder, never 0%
    let vanished = renderStatusItems(
        descriptors: [MenuItemDescriptor(scope: .provider("claude-code"), metric: .quotaUsagePercentage,
                                         binding: .pin(provider: "claude-code", nativeWindowId: "7d Old Name"))],
        quota: quota, activeAccounts: [:])
    expectEqual(vanished.title, "—", "vanished window is a placeholder")
    expect(!vanished.title.contains("0%"), "missing capability never renders as 0%")
}

do {
    // freshness glyph reflects the worst state
    let fresh = renderStatusItems(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .sourceFreshness)],
        quota: [snapshot(agent: "claude-code")], activeAccounts: [:])
    expect(fresh.title.hasPrefix("●"), "healthy sources render the fresh dot")

    let broken = renderStatusItems(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .sourceFreshness)],
        quota: [snapshot(agent: "codex", failureKind: "auth_invalid")], activeAccounts: [:])
    expect(broken.title.hasPrefix("!"), "auth failure renders the risk glyph")
}

// MARK: descriptor store

do {
    // decodes the TypeScript-shaped preferences byte-for-byte
    let json = #"{"version":1,"items":[{"id":"a","scope":{"kind":"provider","provider":"claude-code"},"metric":"quota_usage_percentage","presentation":"text","direction":"used","binding":{"kind":"pin","provider":"claude-code","nativeWindowId":"five_hour"},"providerIdentityPresentation":"icon","unavailableBehavior":"placeholder"}]}"#
    let decoded = try? JSONDecoder().decode(MenuBarBuilderPreferences.self, from: Data(json.utf8))
    expectEqual(decoded?.items.count, 1, "TS-shaped preferences decode")
    expectEqual(decoded?.items.first?.scope, MenuItemScope.provider("claude-code"), "scope union decodes")
    expectEqual(decoded?.items.first?.binding,
                ItemBinding.pin(provider: "claude-code", nativeWindowId: "five_hour"),
                "binding union decodes")
}

do {
    // seeds Auto once, then keeps the user's order
    if let defaults = UserDefaults(suiteName: "llmtally-selftest-\(UUID().uuidString)") {
        let store = DescriptorStore(defaults: defaults)
        let seeded = store.load()
        expectEqual(seeded.map(\.metric),
                    [MenuItemMetric.quotaUsagePercentage, MenuItemMetric.sourceFreshness],
                    "first load seeds the Auto factory")
        store.save(seeded.reversed())
        let reloaded = store.load()
        expectEqual(reloaded.map(\.id), seeded.reversed().map(\.id),
                    "user order survives reload; no re-seeding")
    } else {
        failures += 1
        print("FAIL - could not create test UserDefaults suite")
    }
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all kit checks passed")
