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

    // every gauge-mirroring source ages into stale (audit CX-48);
    // local_logs stays exempt — an idle agent's log is old by definition
    let stale = attention(for: snapshot(agent: "codex", observedAgo: 7200,
        windows: [QuotaWindowDTO(id: "primary (300m)", usedPercent: 5, resetsAtUtc: nil)]))
    expectEqual(stale.rank, AttentionRank.stale, "old vendor_api snapshot is stale")
    let stored = attention(for: snapshot(agent: "grok", source: "stored_history", observedAgo: 7200,
        windows: [QuotaWindowDTO(id: "weekly", usedPercent: 5, resetsAtUtc: nil)]))
    expectEqual(stored.rank, AttentionRank.stale, "old stored_history is stale too — it mirrors a live gauge")
    let logs = attention(for: snapshot(agent: "codex", source: "local_logs", observedAgo: 7200,
        windows: [QuotaWindowDTO(id: "primary (300m)", usedPercent: 5, resetsAtUtc: nil)]))
    expectEqual(logs.rank, AttentionRank.quiet, "old local_logs stays quiet — idle agents' logs age naturally")

    // a free plan is a normal state (2026-08-17): its own rank so the
    // row can say why it has no gauges, but below every real problem,
    // and an aged free row never reads as stale
    let lapsed = attention(for: snapshot(agent: "claude-code", failureKind: "no_subscription"))
    expectEqual(lapsed.rank, AttentionRank.noSubscription, "a lapsed plan gets its own rank")
    expectEqual(isActNowRank(lapsed.rank), false, "a lapsed plan never pins the headline")
    expect(AttentionRank.critical < AttentionRank.noSubscription,
           "a free plan never outranks a real problem")
    expect(AttentionRank.stale < AttentionRank.noSubscription,
           "a free plan never outranks staleness either")
    let agedFree = attention(for: snapshot(agent: "claude-code", observedAgo: 7200,
        failureKind: "no_subscription"))
    expectEqual(agedFree.rank, AttentionRank.noSubscription,
                "an aged free row is normal, not stale")
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
    // both legacy spark ids migrate into quota_cost_history instead of
    // failing the whole preferences blob (terminology renames 08-14/15)
    let legacy = #"{"version":1,"items":[{"id":"m1","scope":{"kind":"aggregate"},"metric":"actual_cost_history","presentation":"bar","unavailableBehavior":"placeholder"},{"id":"m2","scope":{"kind":"aggregate"},"metric":"usage_cost_history","presentation":"bar","unavailableBehavior":"placeholder"}]}"#
    let decoded = try? JSONDecoder().decode(MenuBarBuilderPreferences.self, from: Data(legacy.utf8))
    expectEqual(decoded?.items.count, 2, "legacy spark metric ids decode")
    expectEqual(decoded?.items.first?.metric, MenuItemMetric.quotaCostHistory,
                "actual_cost_history migrates to the quota-cost spark")
    expectEqual(decoded?.items.last?.metric, MenuItemMetric.quotaCostHistory,
                "usage_cost_history migrates to the quota-cost spark")
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
    expectEqual(fired.notifications.first?.severity, NotificationSeverity.actNow, "auth is act-now tier")
    expect(fired.notifications.first?.systemBanner ?? false, "auth still reaches the macOS banner")
}

do {
    // reset-soon fires once per reset instant, bell only, notice tier
    let resetsAt = Date().timeIntervalSince1970 + 12 * 60
    let closing = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 59, resetsAtUtc: resetsAt)])]
    let fired = planNotifications(state: NotificationState(), quota: closing)
    expectEqual(fired.notifications.count, 1, "reset-soon fires for ≥50% within 30m")
    let event = fired.notifications.first
    expectEqual(event?.severity, NotificationSeverity.notice, "reset-soon is a notice")
    expect(!(event?.systemBanner ?? true), "reset-soon stays out of the macOS banner")
    expect(event?.title.contains("59% used") ?? false, "title carries the percent")
    expect(event?.title.contains("resets in") ?? false, "title leads with the reset")

    let again = planNotifications(state: fired.state, quota: closing)
    expectEqual(again.notifications.count, 0, "same reset instant does not re-fire")

    // the NEXT window (new reset instant) is a new episode
    let nextWindow = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 61, resetsAtUtc: resetsAt + 5 * 3600)])]
    _ = nextWindow // (outside 30m → silent; the episode key design is what re-arms)
    let farOut = planNotifications(state: again.state, quota: nextWindow)
    expectEqual(farOut.notifications.count, 0, "a reset far away is silent")
}

do {
    // mismatch and rate-limited: once per episode, bell only
    let mismatch = [snapshot(agent: "claude-code", failureKind: "account_mismatch")]
    let m = planNotifications(state: NotificationState(), quota: mismatch)
    expectEqual(m.notifications.count, 1, "mismatch fires once")
    expectEqual(m.notifications.first?.severity, NotificationSeverity.actNow, "mismatch is act-now")
    expect(!(m.notifications.first?.systemBanner ?? true), "mismatch is bell-only")

    let limited = [snapshot(agent: "grok", failureKind: "rate_limited")]
    let r = planNotifications(state: NotificationState(), quota: limited)
    expectEqual(r.notifications.first?.severity, NotificationSeverity.notice, "rate limit is a notice")
    expectEqual(planNotifications(state: r.state, quota: limited).notifications.count, 0,
                "rate limit fires once per episode")
}

// MARK: notification log (in-app bell)

do {
    let resetsAt = Date().timeIntervalSince1970 + 10 * 60
    let closing = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 59, resetsAtUtc: resetsAt)])]
    let tick = planNotifications(state: NotificationState(), quota: closing)
    var log = logAfterPlanning(NotificationLogState(), planned: tick.notifications,
                               activeKeys: tick.state.activePlannedKeys())
    expectEqual(log.events.count, 1, "planned notification lands in the log")
    expectEqual(unreadNotifications(log).count, 1, "and starts unread")
    expectEqual(worstUnreadSeverity(log), NotificationSeverity.notice, "bell dot severity is notice")

    // a reset-soon episode ends with the reset instant itself: a tick
    // after the reset drops the key → resolved + auto-read
    let afterReset = Date(timeIntervalSince1970: resetsAt + 60)
    let calmTick = planNotifications(state: tick.state, quota: [snapshot(agent: "claude-code")],
                                     now: afterReset)
    log = logAfterPlanning(log, planned: calmTick.notifications,
                           activeKeys: calmTick.state.activePlannedKeys(), now: afterReset)
    expect(log.events.first?.resolvedAtUtc != nil, "passing the reset resolves the event")
    expectEqual(unreadNotifications(log).count, 0, "resolved events read themselves")

    // dismissal removes; act-now rows resist until resolved
    let auth = planNotifications(state: NotificationState(),
                                 quota: [snapshot(agent: "codex", failureKind: "auth_invalid")])
    var authLog = logAfterPlanning(NotificationLogState(), planned: auth.notifications,
                                   activeKeys: auth.state.activePlannedKeys())
    let lockedId = authLog.events[0].id
    authLog = logDismissing(authLog, id: lockedId)
    expectEqual(authLog.events.count, 1, "unresolved act-now row refuses dismissal")
    authLog = logClearingAll(authLog)
    expectEqual(authLog.events.count, 1, "clear-all keeps unresolved act-now rows")

    // retention: old events fall off, the cap holds
    var big = NotificationLogState()
    let old = Date().addingTimeInterval(-15 * 86_400)
    big.events.append(LoggedNotification(
        id: "old#1", key: "warn|x", agent: "codex", severity: .notice,
        title: "old", body: "", createdAtUtc: old.timeIntervalSince1970))
    big = logAfterPlanning(big, planned: [], activeKeys: [])
    expectEqual(big.events.count, 0, "14-day retention drops old events")
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
                        spendCost: CostResultDTO(usd: nil, pricedSubtotalUsd: 0,
                                             pricedRows: 0, unpricedRows: 0),
                        quotaCost: CostResultDTO(usd: usd, pricedSubtotalUsd: usd ?? 0,
                                             pricedRows: usd == nil ? 0 : 1, unpricedRows: 0))
    }
    let buckets = [bucket("2026-08-12", tokens: 100, usd: 1.0),
                   bucket("2026-08-13", tokens: 200, usd: 2.0)]

    expect(supportsPairWindows(agent: "claude-code", quota: quota), "claude returns a 5h+7d pair")

    // pair rails carry both native windows; icon identity emits a glyph first
    let pair = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"), windowSet: "pair")],
        quota: quota, buckets: buckets, activeAccounts: [:])
    expectEqual(pair.segments.first, StatusSegment.glyph(agent: "claude-code"),
                "icon identity renders a drawable glyph segment")
    if pair.segments.count > 1, case .rails(let identity, let bars, _) = pair.segments[1] {
        expectEqual(bars.map(\.windowId), ["five_hour", "seven_day"], "pair rails carry both native ids")
        expectEqual(identity, "", "glyph replaces the inline identity code")
    } else {
        failures += 1
        print("FAIL - pair mini bar did not render rails")
    }
    expectEqual(pair.metrics.count, pair.segments.count, "metrics stay aligned with segments")

    // explicit 1st+2nd windows render two rails in saved order
    let twoRails = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            showWindowLabel: false, showPercentage: false,
            binding: .pin(provider: "claude-code", nativeWindowId: "seven_day"),
            secondNativeWindowId: "five_hour")],
        quota: quota, buckets: buckets, activeAccounts: [:])
    if case .rails(_, let bars, _)? = twoRails.segments.last {
        expectEqual(bars.map(\.windowId), ["seven_day", "five_hour"],
                    "explicit 2nd window renders after the pinned 1st")
    } else {
        failures += 1
        print("FAIL - explicit 1st+2nd rails did not render")
    }

    // a vanished 2nd window drops silently; the 1st rail stays
    let vanishedSecond = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            showWindowLabel: false, showPercentage: false,
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"),
            secondNativeWindowId: "gone_window")],
        quota: quota, buckets: buckets, activeAccounts: [:])
    if case .rails(_, let bars, _)? = vanishedSecond.segments.last {
        expectEqual(bars.map(\.windowId), ["five_hour"], "vanished 2nd window keeps a single rail")
    } else {
        failures += 1
        print("FAIL - rails with a vanished 2nd window did not render")
    }

    // visible-label toggles act on rails: both on = a two-line stack,
    // one on = a single text line, off = glyph+rails only
    let labeledRails = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"))],
        quota: quota, buckets: buckets, activeAccounts: [:])
    expectEqual(labeledRails.segments.last, StatusSegment.stack(top: "5h", bottom: "33%"),
                "both labels render an iStat-style stacked pair")
    let percentOnly = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            showWindowLabel: false,
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"))],
        quota: quota, buckets: buckets, activeAccounts: [:])
    expectEqual(percentOnly.segments.last, StatusSegment.text("33%"),
                "a single label stays one centered line")
    let unlabeledRails = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            showWindowLabel: false, showPercentage: false,
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"))],
        quota: quota, buckets: buckets, activeAccounts: [:])
    expect(!unlabeledRails.segments.contains {
        if case .text = $0 { return true }
        if case .stack = $0 { return true }
        return false
    }, "labels off leaves rails without any label segment")

    // reset display: "at" renders the absolute local time, default
    // stays a countdown
    let resetQuota = [snapshot(agent: "claude-code", windows: [
        QuotaWindowDTO(id: "five_hour", usedPercent: 10,
                       resetsAtUtc: Date(timeIntervalSince1970: 1_755_140_400).timeIntervalSince1970),
    ])]
    let resetAt = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaReset,
            resetDisplay: "at",
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"),
            providerIdentityPresentation: nil)],
        quota: resetQuota, buckets: buckets, activeAccounts: [:],
        now: Date(timeIntervalSince1970: 1_755_100_000))
    if case .text(let atText)? = resetAt.segments.first {
        expect(atText.count >= 8 && atText.contains(":"),
               "reset 'at' renders a weekday + clock time")
    } else {
        failures += 1
        print("FAIL - reset 'at' did not render a text segment")
    }
    let resetCountdown = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaReset,
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"),
            providerIdentityPresentation: nil)],
        quota: resetQuota, buckets: buckets, activeAccounts: [:],
        now: Date(timeIntervalSince1970: 1_755_100_000))
    expectEqual(resetCountdown.segments.first, StatusSegment.text("11h 13m"),
                "reset defaults to the countdown")

    // remaining direction inverts the displayed percent and marks the rails
    let remainingRails = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaMiniBar, presentation: "mini_bar",
            direction: "remaining", showWindowLabel: false,
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"))],
        quota: quota, buckets: buckets, activeAccounts: [:])
    expectEqual(remainingRails.segments.last, StatusSegment.text("67%"),
                "remaining direction shows 100 - used")
    expect(remainingRails.segments.contains {
        if case .rails(_, _, let remaining) = $0 { return remaining }
        return false
    }, "rails carry the remaining flag for the fill direction")

    // vertical_text identity keeps the single text segment (no glyph)
    let coded = renderStatusSegments(
        descriptors: [MenuItemDescriptor(
            scope: .provider("claude-code"), metric: .quotaUsagePercentage, direction: "used",
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour"),
            providerIdentityPresentation: "vertical_text")],
        quota: quota, buckets: buckets, activeAccounts: [:])
    expectEqual(coded.segments, [StatusSegment.text("CLA 5h 33%")],
                "vertical_text stays a single text segment")

    // agent_active counts agents with rows today; empty map = placeholder
    let active = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .agentActive,
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:],
        todayAgentRows: ["claude-code": 12, "codex": 3, "grok": 0])
    expectEqual(active.segments, [StatusSegment.text("2 act")],
                "agent_active counts agents with rows today")
    let inactive = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .agentActive,
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:])
    expectEqual(inactive.segments, [StatusSegment.placeholder],
                "no activity reading renders the missing behaviour")
    let zero = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .agentActive,
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:], todayAgentRows: [:])
    expectEqual(zero.segments, [StatusSegment.text("0 act")],
                "an empty map is a real zero, not a missing reading")

    // folding: only optional metrics fold, from the end, order kept
    let foldAll = foldSegmentIndices(
        metrics: [.quotaUsagePercentage, .quotaReset, .sourceFreshness],
        widths: [100, 50, 40], budget: 500, gap: 6, indicatorWidth: 20)
    expectEqual(foldAll.hiddenCount, 0, "under budget nothing folds")
    let foldSome = foldSegmentIndices(
        metrics: [.quotaUsagePercentage, .quotaReset, .sourceFreshness],
        widths: [100, 50, 40], budget: 160, gap: 6, indicatorWidth: 20)
    expectEqual(foldSome.hiddenCount, 1, "over budget the reset folds")
    expectEqual(foldSome.visible, [0, 2], "quota and freshness never fold; order kept")
    let foldNone = foldSegmentIndices(
        metrics: [.quotaUsagePercentage, .quotaMiniBar],
        widths: [200, 200], budget: 100, gap: 6, indicatorWidth: 20)
    expectEqual(foldNone.hiddenCount, 0, "unfoldable metrics never fold even over budget")

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
    let money = MenuItemDescriptor(scope: .aggregate, metric: .quotaCostHistory,
                                   presentation: "bar", timeRange: "last_7d",
                                   providerIdentityPresentation: nil)
    let visible = renderStatusSegments(descriptors: [money], quota: quota,
                                       buckets: buckets, activeAccounts: [:])
    if case .spark(let values, let isMoney, let isLine)? = visible.segments.first {
        expectEqual(values.count, 2, "cost spark renders the buckets")
        expect(isMoney, "cost spark is marked as money")
        expect(!isLine, "bar presentation stays bars")
    } else {
        failures += 1
        print("FAIL - cost history did not render a spark")
    }

    // 5h/24h ranges ride hour buckets; line presentation carries through.
    // The renderer cuts by wall time now, so the fixture pins `now` to
    // the evening of its own fixed day.
    let hourFormatter = DateFormatter()
    hourFormatter.locale = Locale(identifier: "en_US_POSIX")
    hourFormatter.dateFormat = "yyyy-MM-dd HH:mm"
    let fixtureNow = hourFormatter.date(from: "2026-08-13 23:30")!
    let hourly = (0..<24).map { bucket("2026-08-13 \(String(format: "%02d", $0)):00", tokens: Double($0 + 1), usd: nil) }
    let dayRange = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .consumedTokenHistory,
                                         presentation: "line", timeRange: "last_24h",
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:], hourBuckets: hourly, now: fixtureNow)
    if case .spark(let values, _, let isLine)? = dayRange.segments.first {
        expectEqual(values.count, 24, "last_24h consumes 24 hour buckets")
        expect(isLine, "line presentation renders a line")
        expect(dayRange.tooltip.contains("24 slots, 24 with usage"),
               "dense 24h tooltip reports every slot used")
    } else {
        failures += 1
        print("FAIL - 24h history did not render a spark")
    }
    let sparseDay = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .consumedTokenHistory,
                                         presentation: "bar", timeRange: "last_24h",
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:],
        hourBuckets: [
            bucket("2026-08-13 10:00", tokens: 10, usd: nil),
            bucket("2026-08-13 22:00", tokens: 4, usd: nil),
        ], now: fixtureNow)
    if case .spark(let values, _, _)? = sparseDay.segments.first {
        expectEqual(values.count, 24, "sparse 24h still draws 24 clock-hour slots")
        expectEqual(values[10], 10, "10:00 lands in its own hour slot")
        expectEqual(values[22], 4, "22:00 lands in its own hour slot")
        expectEqual(values.filter { $0 > 0 }.count, 2, "quiet hours stay zero, not dropped")
        expect(sparseDay.tooltip.contains("24 slots, 2 with usage"),
               "sparse 24h tooltip names filled slots separately")
    } else {
        failures += 1
        print("FAIL - sparse 24h history did not render a spark")
    }
    let fiveHour = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .consumedTokenHistory,
                                         presentation: "bar", timeRange: "last_5h",
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:], hourBuckets: hourly, now: fixtureNow)
    if case .spark(let values, _, _)? = fiveHour.segments.first {
        expectEqual(values.count, 5, "last_5h consumes the last 5 hour buckets")
        expectEqual(values.last, 24, "and they are the most recent hours")
    } else {
        failures += 1
        print("FAIL - 5h history did not render a spark")
    }
    // 7d folds hours into midnight-aligned 6h bins and zero-fills the week
    let week = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .consumedTokenHistory,
                                         presentation: "bar", timeRange: "last_7d",
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:], hourBuckets: hourly, now: fixtureNow)
    if case .spark(let values, _, _)? = week.segments.first {
        expectEqual(values.count, 28, "last_7d zero-fills 28 six-hour slots through 23:30")
        expectEqual(values[24], 21, "00–06 is the sum of hours 0…5")
        expectEqual(values[25], 57, "06–12 is the sum of hours 6…11")
        expectEqual(values[26], 93, "12–18 is the sum of hours 12…17")
        expectEqual(values[27], 129, "18–24 is the sum of hours 18…23")
        expect(week.tooltip.contains("28 slots, 4 with usage"),
               "7d tooltip names slots separately from hours that fired")
    } else {
        failures += 1
        print("FAIL - 7d six-hour history did not render a spark")
    }
    let sparseWeek = renderStatusSegments(
        descriptors: [MenuItemDescriptor(scope: .aggregate, metric: .consumedTokenHistory,
                                         presentation: "bar", timeRange: "last_7d",
                                         providerIdentityPresentation: nil)],
        quota: quota, buckets: buckets, activeAccounts: [:],
        hourBuckets: [
            bucket("2026-08-13 10:00", tokens: 10, usd: nil),
            bucket("2026-08-13 11:00", tokens: 5, usd: nil),
        ], now: fixtureNow)
    if case .spark(let values, _, _)? = sparseWeek.segments.first {
        expectEqual(values.count, 28, "one 6h bin of usage still draws the full week")
        expectEqual(values[25], 15, "10:00 and 11:00 fold into the 06–12 bin")
        expectEqual(values.filter { $0 > 0 }.count, 1, "quiet 6h bins stay zero, not dropped")
    } else {
        failures += 1
        print("FAIL - sparse 7d six-hour history did not render a spark")
    }
    let hidden = renderStatusSegments(descriptors: [money], quota: quota,
                                      buckets: buckets, activeAccounts: [:], privacy: true)
    expectEqual(hidden.segments.first, StatusSegment.placeholder, "privacy neutralizes the cost spark")
    expect(hidden.tooltip.contains("Private metric hidden"), "privacy tooltip explains the hidden metric")
}

expect(SWITCHABLE_AGENTS.contains("grok"), "SWITCHABLE includes grok")
expect(SWITCHABLE_AGENTS.contains("cursor-cli"), "SWITCHABLE includes cursor-cli")
expectEqual(agentDisplayName("cursor-cli"), "Cursor", "cursor-cli display name")
expect(agentHasBrandGlyph("cursor-cli"), "cursor-cli has a brand glyph")
expect(agentHasBrandGlyph("grok"), "grok has a brand glyph")

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all kit checks passed")
