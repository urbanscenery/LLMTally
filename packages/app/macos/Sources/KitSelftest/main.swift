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

// MARK: notification planner

do {
    // a crossing fires once, repeats are silent, dropping below re-arms
    let hot = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 75, resetsAtUtc: nil)])]
    let first = planNotifications(state: NotificationState(), quota: hot)
    expectEqual(first.notifications.count, 1, "warning crossing fires once")
    expect(first.notifications.first?.title.contains("75% used") ?? false, "crossing title carries the percent")

    let second = planNotifications(state: first.state, quota: hot)
    expectEqual(second.notifications.count, 0, "same reading does not re-fire")

    let cooled = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 10, resetsAtUtc: nil)])]
    let third = planNotifications(state: second.state, quota: cooled)
    expectEqual(third.notifications.count, 0, "cooling down is silent")

    let reheated = planNotifications(state: third.state, quota: hot)
    expectEqual(reheated.notifications.count, 1, "reset re-arms the same threshold")
}

do {
    // a jump straight past both lines fires critical only
    let spike = [snapshot(agent: "codex", windows: [
        QuotaWindowDTO(id: "primary (300m)", usedPercent: 95, resetsAtUtc: nil)])]
    let fired = planNotifications(state: NotificationState(), quota: spike)
    expectEqual(fired.notifications.count, 1, "spike past 70 and 90 fires one notification")
    expect(fired.notifications.first?.key.hasPrefix("crit|") ?? false, "and it is the critical one")
}

do {
    // auth fires immediately once; the body names no email
    let broken = [snapshot(agent: "codex", account: "secret@example.com", failureKind: "auth_invalid")]
    let fired = planNotifications(state: NotificationState(), quota: broken)
    expectEqual(fired.notifications.count, 1, "auth fires immediately")
    let text = (fired.notifications.first?.title ?? "") + (fired.notifications.first?.body ?? "")
    expect(!text.contains("secret@example.com"), "notification text carries no email")
    let again = planNotifications(state: fired.state, quota: broken)
    expectEqual(again.notifications.count, 0, "auth fires once per episode")
}

// MARK: privacy

do {
    let quota = [
        snapshot(agent: "claude-code", account: "secret@example.com", windows: [
            QuotaWindowDTO(id: "five_hour", usedPercent: 33, resetsAtUtc: nil)]),
        snapshot(agent: "codex", windows: [
            QuotaWindowDTO(id: "primary (300m)", usedPercent: 5, resetsAtUtc: nil)]),
    ]
    let descriptors = [MenuItemDescriptor(
        scope: .provider("claude-code"), metric: .quotaUsagePercentage, direction: "used",
        binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"))]

    let hidden = renderStatusItems(descriptors: descriptors, quota: quota,
                                   activeAccounts: [:], privacy: true)
    expect(hidden.title.contains("P1"), "privacy replaces the code with a stable alias")
    expect(!hidden.title.contains("CLA"), "no provider code leaks in the title")
    expect(!hidden.tooltip.contains("secret@example.com"), "no email leaks in the tooltip")
    expect(hidden.tooltip.contains("Account hidden"), "tooltip states the account is hidden")

    let aliases = privacyAliases(for: quota)
    expectEqual(aliases["claude-code"], "P1", "aliases are deterministic (sorted agents)")
    expectEqual(aliases["codex"], "P2", "second agent is P2")

    // privacy notifications use the alias too
    let authQuota = [snapshot(agent: "codex", failureKind: "auth_invalid")]
    let fired = planNotifications(state: NotificationState(), quota: authQuota, privacy: true)
    expect(fired.notifications.first?.title.hasPrefix("P1") ?? false,
           "privacy notification uses the alias, not the provider name")
}

// MARK: graphical segments

do {
    let quota = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 33, resetsAtUtc: nil),
        QuotaWindowDTO(id: "seven_day", usedPercent: 12, resetsAtUtc: nil),
    ])]
    func bucket(_ key: String, tokens: Double, usd: Double?) -> ReportBucketDTO {
        ReportBucketDTO(key: key, rowCount: 1,
                        tokens: TokenTotalsDTO(inputTokens: tokens, outputTokens: 0),
                        actual: CostResultDTO(usd: usd, pricedSubtotalUsd: usd ?? 0,
                                              pricedRows: usd == nil ? 0 : 1, unpricedRows: 0))
    }
    let buckets = [bucket("2026-08-12", tokens: 100, usd: 1.0),
                   bucket("2026-08-13", tokens: 200, usd: 2.0)]

    expect(supportsPairWindows(agent: "claude-code", quota: quota), "claude returns a 5h+7d pair")

    // pair rails carry both native windows
    let pair = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"), windowSet: "pair")],
        quota: quota, buckets: buckets, activeAccounts: [:])
    if case .rails(_, let bars) = pair.segments.first {
        expectEqual(bars.map(\.windowId), ["five_hour", "seven_day"], "pair rails carry both native ids")
    } else {
        failures += 1
        print("FAIL - pair mini bar did not render rails")
    }

    // a provider without the pair renders the missing behaviour, never a fake rail
    let grokQuota = [snapshot(agent: "grok", windows: [
        QuotaWindowDTO(id: "weekly", usedPercent: 26, resetsAtUtc: nil)])]
    expect(!supportsPairWindows(agent: "grok", quota: grokQuota), "weekly-only grok has no pair")

    // fewer than 2 buckets: placeholder, not a trend
    let thin = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .consumedTokenHistory,
                                         presentation: "bar", timeRange: "last_7d",
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: [buckets[0]], activeAccounts: [:])
    expectEqual(thin.segments.first, StatusSegment.placeholder, "one bucket renders a placeholder, not a trend")

    // cost spark disappears under privacy
    let money = MenuItemDescriptor(scope: .aggregate, metric: .actualCostHistory,
                                   presentation: "bar", timeRange: "last_7d",
                                   providerIdentityPresentation: nil)
    let visible = renderStatusSegments(descriptors: [money], quota: quota,
                                       buckets: buckets, activeAccounts: [:])
    if case .spark(let values, let isMoney)? = visible.segments.first {
        expectEqual(values.count, 2, "cost spark renders the buckets")
        expect(isMoney, "cost spark is marked as money")
    } else {
        failures += 1
        print("FAIL - cost history did not render a spark")
    }
    let hidden = renderStatusSegments(descriptors: [money], quota: quota,
                                      buckets: buckets, activeAccounts: [:], privacy: true)
    expectEqual(hidden.segments.first, StatusSegment.placeholder, "privacy neutralizes the cost spark")
    expect(hidden.tooltip.contains("Private metric hidden"), "privacy tooltip explains the hidden metric")
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all kit checks passed")
