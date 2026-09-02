import LLMTallyKit
import SwiftUI

/// The Builder — the key-spec editor (03_design_spec §6). Owns the
/// live preview, add/edit/duplicate/reorder/remove, and persistence.
/// Every change saves immediately (no Save button) and notifies the
/// status item. The preview and the real status item share
/// `renderStatusItems`; this view never draws its own approximation.
struct BuilderView: View {
    /// nil when the Builder IS the Settings pane (no back navigation).
    let onBack: (() -> Void)?

    @State private var items: [MenuItemDescriptor]
    @State private var selectedId: String?
    @State private var quota: [QuotaSnapshotDTO] = []
    @State private var buckets: [ReportBucketDTO] = []
    @State private var hourBuckets: [ReportBucketDTO] = []
    @State private var todayRows: [String: Int]?
    /// Why the provider catalog could not be read this time. The Builder
    /// keeps working from pinned providers; the note says the picker may
    /// be short until the next successful read (2026-08-16: a silent
    /// failure left Grok missing from the picker for a whole day).
    @State private var catalogError: String?
    @State private var draggedId: String?
    /// Width budget (§6.5). Squeezing simulates a crowded menu bar;
    /// the value persists and the real status item folds with it too.
    @State private var budget: Double = AppConfig.menuBarBudget
    private let store = DescriptorStore()

    init(onBack: (() -> Void)? = nil) {
        self.onBack = onBack
        let loaded = DescriptorStore().load()
        _items = State(initialValue: loaded)
        _selectedId = State(initialValue: loaded.first?.id)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            preview
            Divider()
            HStack(spacing: 0) {
                itemList.frame(width: 280)
                Divider()
                editor.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            Divider()
            Text("Same renderer as the menu bar · changes apply instantly · accounts are never switched here")
                .font(.caption2).foregroundStyle(.secondary)
                .padding(6)
        }
        .onAppear(perform: loadQuota)
        // the Settings window is created once and re-shown, so this view
        // outlives its first appearance — a catalog captured while a
        // source was mid-rewrite would otherwise stay stale until relaunch
        .onReceive(NotificationCenter.default.publisher(for: .llmtallySettingsShown)) { _ in
            loadQuota()
        }
    }

    // MARK: header + preview

    private var header: some View {
        HStack {
            if let onBack {
                Button {
                    onBack()
                } label: {
                    Label("Menu bar", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
            } else {
                Text("Menu bar").font(.headline)
            }
            Spacer()
            Text("BUILDER · KEY SPEC").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
    }

    /// Fake menubar chrome so the item is judged in its real habitat.
    /// The image comes from StatusComposer — the exact renderer the
    /// real status button uses.
    private var preview: some View {
        let rendering = renderStatusSegments(
            descriptors: items, quota: quota, buckets: buckets,
            activeAccounts: [:], hourBuckets: hourBuckets,
            todayAgentRows: todayRows,
            privacy: PrivacySetting.enabled,
            spendCost: AppConfig.spendMode)
        // the note must agree with the composer: same content budget,
        // same +N indicator width
        let widths = rendering.segments.map { Double(StatusComposer.width(of: $0)) }
        let fold = foldSegmentIndices(
            metrics: rendering.metrics, widths: widths,
            budget: StatusComposer.contentBudget(budget, leadingTally: rendering.segments.isEmpty),
            gap: 6,
            indicatorWidth: StatusComposer.indicatorWidth)
        let fullWidth = widths.reduce(0, +) + Double(max(0, widths.count - 1)) * 6 + 24

        // a framed mini-screen mockup (menu bar strip over a wallpaper)
        // with a PREVIEW badge — unmistakably a simulation, not UI chrome
        return VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                VStack(spacing: 0) {
                    HStack(spacing: 14) {
                        Text("Finder").font(.system(size: 12, weight: .semibold)).opacity(0.6)
                        Text("File").font(.system(size: 12)).opacity(0.5)
                        Text("Edit").font(.system(size: 12)).opacity(0.5)
                        Spacer()
                        Image(nsImage: StatusComposer.compose(
                            segments: rendering.segments,
                            metrics: rendering.metrics,
                            budget: CGFloat(budget),
                            // same rule as the real status item: the
                            // tally mark only stands in when there is
                            // nothing else to draw
                            leadingTally: rendering.segments.isEmpty))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.08)))
                            .help(rendering.tooltip)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 26)
                    .background(Color.primary.opacity(0.07))

                    // fake desktop below the strip sells the screen mock
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.30), Color.accentColor.opacity(0.08)],
                        startPoint: .topLeading, endPoint: .bottomTrailing)
                        .frame(height: 30)
                }
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7)
                    .stroke(Color.primary.opacity(0.25), lineWidth: 1))

                Text("PREVIEW")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Color(nsColor: .windowBackgroundColor))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.primary.opacity(0.85)))
                    .offset(x: 10, y: -9)
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)

            HStack(spacing: 10) {
                Text("\(Int(fullWidth)) / \(Int(budget)) pt")
                    .font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                Slider(value: Binding(
                    get: { budget },
                    set: { value in
                        budget = value
                        AppConfig.setMenuBarBudget(value)
                        // the real bar folds with the same budget
                        NotificationCenter.default.post(
                            name: .llmtallyDescriptorsChanged, object: nil)
                    }), in: Double(StatusComposer.minBudget)...Double(StatusComposer.maxBudget)) {
                    Text("Squeeze")
                }
                .controlSize(.small)
                .frame(maxWidth: 220)
                Spacer()
                if fold.hiddenCount > 0 {
                    Text("Compacted · \(fold.hiddenCount) folded · order kept")
                        .font(.caption2).foregroundStyle(.orange)
                }
                if let catalogError {
                    Text("Provider catalog unavailable · pinned providers kept")
                        .font(.caption2).foregroundStyle(.orange)
                        .help(catalogError)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
        }
    }

    // MARK: list

    private var itemList: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    itemRow(item, index: index)
                        .opacity(draggedId == item.id ? 0.4 : 1)
                        .onDrag {
                            draggedId = item.id
                            return NSItemProvider(object: item.id as NSString)
                        }
                        .onDrop(of: [.text], delegate: DragReorderDelegate(
                            itemId: item.id, draggedId: $draggedId,
                            indexOf: { id in items.firstIndex { $0.id == id } },
                            move: { from, to in
                                mutate { $0.moveElement(from: from, to: to) }
                            }))
                    Divider()
                }
                addMenu.padding(10)
            }
        }
    }

    private func itemRow(_ item: MenuItemDescriptor, index: Int) -> some View {
        HStack(spacing: 6) {
            // mini render of just this item — same composer as the bar
            Image(nsImage: StatusComposer.compose(
                segments: renderStatusSegments(
                    descriptors: [item], quota: quota, buckets: buckets,
                    activeAccounts: [:], hourBuckets: hourBuckets,
                    todayAgentRows: todayRows,
                    privacy: PrivacySetting.enabled,
                    spendCost: AppConfig.spendMode).segments,
                leadingTally: false))
                .frame(maxWidth: 64, alignment: .leading)
                .clipped()
                .padding(2)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.05)))
            VStack(alignment: .leading, spacing: 1) {
                Text(metricName(item.metric)).font(.caption.weight(.medium))
                Text(itemSubtitle(item)).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button("↑") { move(index, by: -1) }.disabled(index == 0)
            Button("↓") { move(index, by: 1) }.disabled(index == items.count - 1)
            Button("⧉") { duplicate(index) }
            // the last item cannot be removed (§6.5)
            Button("×") { remove(index) }.disabled(items.count == 1)
        }
        .buttonStyle(.plain)
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .background(selectedId == item.id ? Color.accentColor.opacity(0.14) : .clear)
        .onTapGesture { selectedId = item.id }
    }

    private var addMenu: some View {
        Menu("＋ Add item") {
            Section("Quota") {
                Button("Quota %") { add(.quotaUsagePercentage) }
                Button("Quota rails") { add(.quotaMiniBar) }
                Button("Reset countdown") { add(.quotaReset) }
            }
            Section("History") {
                Button("Token spark") { add(.consumedTokenHistory) }
                Button("Quota cost spark") { add(.quotaCostHistory) }
            }
            Section("Context") {
                Button("Freshness") { add(.sourceFreshness) }
                Button("Provider label") { add(.providerLabel) }
                Button("Agent active") { add(.agentActive) }
                Button("Spacer") { add(.spacer) }
            }
        }
        .menuStyle(.borderlessButton)
        .frame(maxWidth: .infinity)
    }

    // MARK: editor

    @ViewBuilder
    private var editor: some View {
        if let index = items.firstIndex(where: { $0.id == selectedId }) {
            let item = items[index]
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(metricName(item.metric)).font(.headline)
                    Text("Active account is read-only. Each quota item pins one provider's native window.")
                        .font(.caption2).foregroundStyle(.secondary)

                    if let about = metricDescription(item.metric) {
                        section("About") {
                            Text(about)
                                .font(.caption2).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    if isQuotaMetric(item.metric) {
                        providerSection(item, index: index)
                        windowSection(item, index: index)
                        if item.metric == .quotaMiniBar {
                            secondWindowSection(item, index: index)
                        }
                        if item.metric == .quotaReset {
                            // reset has no direction/labels — it shows
                            // one time, as a countdown or an absolute
                            resetDisplaySection(item, index: index)
                        } else {
                            directionSection(item, index: index)
                            labelSection(item, index: index)
                        }
                    }
                    if item.metric == .providerLabel {
                        providerSection(item, index: index)
                    }
                    if isHistoryMetric(item.metric) {
                        historySection(item, index: index)
                    }
                    // dead controls stay out: identity only where the
                    // renderer reads it, if-missing only where a missing
                    // reading actually renders a placeholder
                    if identityApplies(item.metric) {
                        identitySection(item, index: index,
                                        allowNone: item.metric != .providerLabel)
                    }
                    if missingApplies(item.metric) {
                        missingSection(item, index: index)
                    }
                }
                .padding(16)
            }
        } else {
            Text("Select an item").font(.caption).foregroundStyle(.secondary).padding(20)
        }
    }

    private func providerSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("Provider") {
            Picker("", selection: Binding(
                get: { pinProvider(item.binding) ?? scopeProvider(item.scope) ?? firstProvider() },
                set: { provider in
                    mutate { current in
                        current[index].binding = .pin(
                            provider: provider,
                            nativeWindowId: firstWindowId(of: provider))
                        current[index].scope = .provider(provider)
                        // window ids are per-provider — a carried-over
                        // 2nd rail would point at a foreign window
                        current[index].secondNativeWindowId = nil
                    }
                })) {
                ForEach(pickerProviders(), id: \.self) { provider in
                    Text("\(agentShortCode(provider)) · \(agentDisplayName(provider))").tag(provider)
                }
            }
            .labelsHidden()
        }
    }

    private func windowSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        let provider = pinProvider(item.binding) ?? firstProvider()
        let title = item.metric == .quotaMiniBar ? "1st window · required" : "Window · native id"
        // only windows the source actually returned — never a fixed enum
        return section(title) {
            Picker("", selection: Binding(
                get: { pinWindowId(item.binding) ?? "" },
                set: { windowId in
                    mutate { current in
                        current[index].binding = .pin(provider: provider, nativeWindowId: windowId)
                        // the same window can't be both rails
                        if current[index].secondNativeWindowId == windowId {
                            current[index].secondNativeWindowId = nil
                        }
                    }
                })) {
                ForEach(windowIds(of: provider), id: \.self) { windowId in
                    Text("\(shortWindowLabel(windowId)) · \(windowId)").tag(windowId)
                }
            }
            .labelsHidden()
            if windowIds(of: provider).isEmpty {
                Text("This source has not returned any windows yet.")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
    }

    /// Rails only: the optional 2nd rail. "None" keeps a single rail;
    /// picking a window renders two. Replaces the fixed pair toggle for
    /// pinned rails (a legacy saved pair pre-selects its 7d window).
    private func secondWindowSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        let provider = pinProvider(item.binding) ?? firstProvider()
        let firstId = pinWindowId(item.binding) ?? ""
        let options = windowIds(of: provider).filter { $0 != firstId }
        return section("2nd window · optional") {
            Picker("", selection: Binding(
                get: {
                    if let second = item.secondNativeWindowId { return second }
                    if item.windowSet == "pair",
                       let legacy = options.first(where: { shortWindowLabel($0) == "7d" }) {
                        return legacy
                    }
                    return ""
                },
                set: { windowId in
                    mutate { current in
                        current[index].secondNativeWindowId = windowId.isEmpty ? nil : windowId
                        current[index].windowSet = windowId.isEmpty ? "single" : nil
                    }
                })) {
                Text("None · single rail").tag("")
                ForEach(options, id: \.self) { windowId in
                    Text("\(shortWindowLabel(windowId)) · \(windowId)").tag(windowId)
                }
            }
            .labelsHidden()
        }
    }

    private func historySection(_ item: MenuItemDescriptor, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            section("Range") {
                Picker("", selection: Binding(
                    get: { item.timeRange ?? "last_7d" },
                    set: { value in mutate { $0[index].timeRange = value } })) {
                    Text("5h").tag("last_5h")
                    Text("1 day").tag("last_24h")
                    Text("7 days").tag("last_7d")
                }
                .pickerStyle(.segmented).labelsHidden()
                Text("5h and 1 day ride hour buckets and fill quiet hours so a short session does not look like a shorter range. 7 days folds those hours into 6-hour bins (midnight-aligned) and fills quiet slots; falls back to daily when there is no hour history.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            section("Chart") {
                Picker("", selection: Binding(
                    get: { item.presentation == "line" ? "line" : "bar" },
                    set: { value in mutate { $0[index].presentation = value } })) {
                    Text("Bars").tag("bar")
                    Text("Line").tag("line")
                }
                .pickerStyle(.segmented).labelsHidden()
            }
            Text("Fewer than 2 real buckets renders the missing behaviour — never an invented trend.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func resetDisplaySection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("Display") {
            Picker("", selection: Binding(
                get: { item.resetDisplay ?? "countdown" },
                set: { value in mutate { $0[index].resetDisplay = value } })) {
                Text("Countdown · 2h 5m").tag("countdown")
                Text("At · Wed 06:00").tag("at")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private func directionSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("Direction") {
            Picker("", selection: Binding(
                get: { item.direction ?? "used" },
                set: { value in mutate { $0[index].direction = value } })) {
                Text("used").tag("used")
                Text("remaining").tag("remaining")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private func labelSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("Visible labels") {
            Toggle("Window label", isOn: Binding(
                get: { item.showWindowLabel ?? true },
                set: { value in mutate { $0[index].showWindowLabel = value } }))
            Toggle("Percent", isOn: Binding(
                get: { item.showPercentage ?? true },
                set: { value in mutate { $0[index].showPercentage = value } }))
            Text("Hidden labels stay in the tooltip and VoiceOver.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func identitySection(_ item: MenuItemDescriptor, index: Int,
                                 allowNone: Bool = true) -> some View {
        section("Identity") {
            Picker("", selection: Binding(
                get: { item.providerIdentityPresentation ?? "icon" },
                set: { value in mutate { $0[index].providerIdentityPresentation = value } })) {
                Text("Icon").tag("icon")
                Text("Code").tag("vertical_text")
                // a provider label IS its identity — "none" would
                // render nothing, so the option only exists elsewhere
                if allowNone {
                    Text("None · VO keeps name").tag("none")
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    /// The renderer reads identity only for quota % / rails and the
    /// provider label; reset, freshness, agent-active, history, and
    /// spacer ignore it entirely.
    private func identityApplies(_ metric: MenuItemMetric) -> Bool {
        metric == .quotaUsagePercentage || metric == .quotaMiniBar || metric == .providerLabel
    }

    /// Metrics where a missing reading actually renders the chosen
    /// behaviour. Freshness and the provider label simply hide when
    /// there is nothing to show; spacer has no data at all.
    private func missingApplies(_ metric: MenuItemMetric) -> Bool {
        isQuotaMetric(metric) || isHistoryMetric(metric) || metric == .agentActive
    }

    private func metricDescription(_ metric: MenuItemMetric) -> String? {
        switch metric {
        case .agentActive:
            return "The number of agents with at least one prompt in today's local ledger (calendar day, local midnight reset). Quota is not involved — this is pure usage. \"2 act\" means two agents logged prompts today; VoiceOver reads which ones."
        case .providerLabel:
            return "A static identity stamp — the provider's glyph or short code — for labeling the items next to it. It never changes with usage; privacy mode swaps in a neutral alias."
        case .sourceFreshness:
            return "One-glance trust summary across all providers: ● fresh · ◷ stale or rate-limited · ! auth invalid, plus the age of the oldest reading. It never folds when the bar squeezes."
        default:
            return nil
        }
    }

    private func missingSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("If missing") {
            Picker("", selection: Binding(
                get: { item.unavailableBehavior },
                set: { value in mutate { $0[index].unavailableBehavior = value } })) {
                Text("Hide").tag("hidden")
                Text("Placeholder · never 0%").tag("placeholder")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            content()
        }
    }

    // MARK: mutations — every change persists and notifies immediately

    private func mutate(_ change: (inout [MenuItemDescriptor]) -> Void) {
        change(&items)
        store.save(items)
        NotificationCenter.default.post(name: .llmtallyDescriptorsChanged, object: nil)
    }

    private func move(_ index: Int, by offset: Int) {
        let target = index + offset
        guard target >= 0 && target < items.count else { return }
        mutate { $0.swapAt(index, target) }
    }

    private func duplicate(_ index: Int) {
        mutate { current in
            let source = current[index]
            let copy = MenuItemDescriptor(
                scope: source.scope, metric: source.metric, presentation: source.presentation,
                direction: source.direction, timeRange: source.timeRange,
                resetDisplay: source.resetDisplay, showRangeLabel: source.showRangeLabel,
                showWindowLabel: source.showWindowLabel, showPercentage: source.showPercentage,
                binding: source.binding, windowSet: source.windowSet,
                secondNativeWindowId: source.secondNativeWindowId,
                providerIdentityPresentation: source.providerIdentityPresentation,
                unavailableBehavior: source.unavailableBehavior)
            current.insert(copy, at: index + 1)
            selectedId = copy.id
        }
    }

    private func remove(_ index: Int) {
        guard items.count > 1 else { return }
        mutate { current in
            let removed = current.remove(at: index)
            if selectedId == removed.id { selectedId = current.first?.id }
        }
    }

    private func add(_ metric: MenuItemMetric) {
        mutate { current in
            let descriptor: MenuItemDescriptor
            switch metric {
            case .quotaUsagePercentage, .quotaReset, .quotaMiniBar:
                let provider = firstProvider()
                descriptor = MenuItemDescriptor(
                    scope: .provider(provider), metric: metric,
                    presentation: metric == .quotaMiniBar ? "mini_bar" : "text",
                    direction: "used",
                    binding: .pin(provider: provider, nativeWindowId: firstWindowId(of: provider)),
                    windowSet: metric == .quotaMiniBar ? "single" : nil)
            case .consumedTokenHistory, .quotaCostHistory:
                descriptor = MenuItemDescriptor(
                    scope: .aggregate, metric: metric, presentation: "bar",
                    timeRange: "last_7d", providerIdentityPresentation: nil)
            case .providerLabel:
                descriptor = MenuItemDescriptor(scope: .provider(firstProvider()), metric: metric)
            default:
                descriptor = MenuItemDescriptor(scope: .aggregate, metric: metric,
                                                providerIdentityPresentation: nil)
            }
            current.append(descriptor)
            selectedId = descriptor.id
        }
    }

    // MARK: capability catalog — only what the sources actually returned

    private func loadQuota() {
        // read-only: the Builder never burns refresh budget
        SidecarClient.shared.requestDecodable("overview", params: ["refresh": false], as: OverviewDTO.self) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let value):
                    quota = value.quota
                    buckets = value.report.buckets
                    catalogError = nil
                    migrateLegacyBindings()
                case .failure(let error):
                    // keep whatever catalog we had; say that it may be short
                    catalogError = error.localizedDescription
                }
            }
        }
        SidecarClient.shared.requestDecodable("todayByAgent", as: [String: Int].self) { result in
            DispatchQueue.main.async {
                if case .success(let value) = result { todayRows = value }
            }
        }
        SidecarClient.shared.requestDecodable("report", params: OverviewModel.hourReportParams(), as: ReportSummaryDTO.self) { result in
            DispatchQueue.main.async {
                if case .success(let summary) = result { hourBuckets = summary.buckets }
            }
        }
    }

    /// Follow-attention was removed from the Builder — legacy quota
    /// items re-pin to the first provider's first window once the
    /// window catalog is actually known.
    private func migrateLegacyBindings() {
        let hasEmptyPin = items.contains { item in
            if case .pin(_, let windowId) = item.binding { return windowId.isEmpty }
            return false
        }
        guard !quota.isEmpty,
              hasEmptyPin || items.contains(where: { isQuotaMetric($0.metric) && !isPin($0.binding) })
        else { return }
        mutate { current in
            for index in current.indices
            where isQuotaMetric(current[index].metric) && !isPin(current[index].binding) {
                let provider = firstProvider()
                current[index].binding = .pin(
                    provider: provider, nativeWindowId: firstWindowId(of: provider))
                current[index].scope = .provider(provider)
            }
            // items added before any quota arrived carry an empty
            // window id — fill it now that the catalog is real. When
            // the pinned provider never showed up (the pre-data
            // "claude-code" guess), repoint to a provider that DID
            // (audit grok C2-15)
            for index in current.indices {
                if case .pin(let provider, let windowId) = current[index].binding,
                   windowId.isEmpty {
                    let fresh = firstWindowId(of: provider)
                    if !fresh.isEmpty {
                        current[index].binding = .pin(provider: provider, nativeWindowId: fresh)
                    } else if !catalogProviders().contains(provider) {
                        let fallback = firstProvider()
                        let window = firstWindowId(of: fallback)
                        if !window.isEmpty {
                            current[index].binding = .pin(provider: fallback, nativeWindowId: window)
                            current[index].scope = .provider(fallback)
                        }
                    }
                }
            }
        }
    }

    private func catalogProviders() -> [String] {
        var seen: [String] = []
        for snapshot in quota where !seen.contains(snapshot.agent) {
            seen.append(snapshot.agent)
        }
        return seen.isEmpty ? ["claude-code"] : seen
    }

    /// What the provider picker offers: every provider the sources
    /// returned, plus every provider an item already pins. A pin must
    /// never fall out of its own picker because one read came back
    /// short — the source-driven `catalogProviders()` stays as it is for
    /// migration and defaults, so an unseen provider is still repointed
    /// there, never here.
    private func pickerProviders() -> [String] {
        var seen = catalogProviders()
        for item in items {
            if let provider = pinProvider(item.binding), !seen.contains(provider) {
                seen.append(provider)
            }
        }
        return seen
    }

    private func windowIds(of provider: String) -> [String] {
        var seen: [String] = []
        for snapshot in quota where snapshot.agent == provider {
            for window in snapshot.windows where !seen.contains(window.id) {
                seen.append(window.id)
            }
        }
        return seen
    }

    private func firstProvider() -> String { catalogProviders().first ?? "claude-code" }

    private func firstWindowId(of provider: String) -> String {
        // never fabricate a window id: a synthesized "five_hour" pin on
        // a provider that reports no such window renders a permanent
        // "—" with no explanation (audit GK-59). An empty id keeps the
        // editor's "no windows reported" guidance visible instead.
        windowIds(of: provider).first ?? ""
    }

    private func isQuotaMetric(_ metric: MenuItemMetric) -> Bool {
        metric == .quotaUsagePercentage || metric == .quotaReset || metric == .quotaMiniBar
    }

    private func isHistoryMetric(_ metric: MenuItemMetric) -> Bool {
        metric == .consumedTokenHistory || metric == .quotaCostHistory
    }

    private func isPin(_ binding: ItemBinding?) -> Bool {
        if case .pin = binding { return true }
        return false
    }

    private func pinProvider(_ binding: ItemBinding?) -> String? {
        if case .pin(let provider, _) = binding { return provider }
        return nil
    }

    private func scopeProvider(_ scope: MenuItemScope) -> String? {
        if case .provider(let provider) = scope { return provider }
        return nil
    }

    private func pinWindowId(_ binding: ItemBinding?) -> String? {
        if case .pin(_, let windowId) = binding { return windowId }
        return nil
    }

    private func metricName(_ metric: MenuItemMetric) -> String {
        switch metric {
        case .quotaUsagePercentage: return "Quota %"
        case .quotaMiniBar: return "Quota rails"
        case .quotaReset: return "Reset"
        case .sourceFreshness: return "Freshness"
        case .providerLabel: return "Provider label"
        case .consumedTokenHistory: return "Token history"
        case .quotaCostHistory: return "Quota cost"
        case .agentActive: return "Agent active"
        case .spacer: return "Spacer"
        }
    }

    private func itemSubtitle(_ item: MenuItemDescriptor) -> String {
        switch item.binding {
        case .followAttention: return "unpinned"
        case .pin(let provider, let windowId):
            if let second = item.secondNativeWindowId {
                return "\(provider) · \(windowId) + \(second)"
            }
            return "\(provider) · \(windowId)"
        case nil:
            if case .provider(let provider) = item.scope { return provider }
            return "aggregate"
        }
    }
}

