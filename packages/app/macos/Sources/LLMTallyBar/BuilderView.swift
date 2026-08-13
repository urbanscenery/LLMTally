import LLMTallyKit
import SwiftUI

/// The Builder — the key-spec editor (03_design_spec §6). Owns the
/// live preview, add/edit/duplicate/reorder/remove, and persistence.
/// Every change saves immediately (no Save button) and notifies the
/// status item. The preview and the real status item share
/// `renderStatusItems`; this view never draws its own approximation.
struct BuilderView: View {
    let onBack: () -> Void

    @State private var items: [MenuItemDescriptor]
    @State private var selectedId: String?
    @State private var quota: [QuotaSnapshotDTO] = []
    @State private var buckets: [ReportBucketDTO] = []
    @State private var todayRows: [String: Int]?
    /// Squeeze simulation (§6.5): reproduces a crowded menu bar.
    @State private var budget: Double = Double(StatusComposer.defaultBudget)
    private let store = DescriptorStore()

    init(onBack: @escaping () -> Void) {
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
    }

    // MARK: header + preview

    private var header: some View {
        HStack {
            Button {
                onBack()
            } label: {
                Label("Menu bar", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
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
            activeAccounts: [:], todayAgentRows: todayRows,
            privacy: PrivacySetting.enabled)
        // the note must agree with the composer: same content budget,
        // same +N indicator width
        let widths = rendering.segments.map { Double(StatusComposer.width(of: $0)) }
        let fold = foldSegmentIndices(
            metrics: rendering.metrics, widths: widths,
            budget: StatusComposer.contentBudget(budget), gap: 6,
            indicatorWidth: StatusComposer.indicatorWidth)
        let fullWidth = widths.reduce(0, +) + Double(max(0, widths.count - 1)) * 6 + 24

        return VStack(spacing: 0) {
            HStack(spacing: 14) {
                Text("Finder").font(.system(size: 12, weight: .semibold)).opacity(0.6)
                Text("File").font(.system(size: 12)).opacity(0.5)
                Text("Edit").font(.system(size: 12)).opacity(0.5)
                Spacer()
                Image(nsImage: StatusComposer.compose(
                    segments: rendering.segments,
                    metrics: rendering.metrics,
                    budget: CGFloat(budget)))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.08)))
                    .help(rendering.tooltip)
            }
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(Color.primary.opacity(0.05))

            HStack(spacing: 10) {
                Text("\(Int(fullWidth)) / \(Int(budget)) pt")
                    .font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                Slider(value: $budget, in: 200...Double(StatusComposer.defaultBudget)) {
                    Text("Squeeze")
                }
                .controlSize(.small)
                .frame(maxWidth: 220)
                Spacer()
                if fold.hiddenCount > 0 {
                    Text("Compacted · \(fold.hiddenCount) folded · order kept")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 26)
        }
    }

    // MARK: list

    private var itemList: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    itemRow(item, index: index)
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
                    activeAccounts: [:], todayAgentRows: todayRows).segments,
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
                Button("Actual cost spark") { add(.actualCostHistory) }
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
                    Text("Active account is read-only. Pin a native window or follow the attention ranking.")
                        .font(.caption2).foregroundStyle(.secondary)

                    if isQuotaMetric(item.metric) {
                        bindingSection(item, index: index)
                        if case .pin = item.binding ?? .followAttention {
                            providerSection(item, index: index)
                            windowSection(item, index: index)
                        }
                        if item.metric == .quotaMiniBar {
                            pairSection(item, index: index)
                        }
                        directionSection(item, index: index)
                        labelSection(item, index: index)
                    }
                    if isHistoryMetric(item.metric) {
                        Text("Ledger history, last 7 daily buckets. Fewer than 2 real buckets renders the missing behaviour — never an invented trend.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if item.metric != .spacer && !isHistoryMetric(item.metric) {
                        identitySection(item, index: index)
                    }
                    if item.metric != .spacer {
                        missingSection(item, index: index)
                    }
                }
                .padding(16)
            }
        } else {
            Text("Select an item").font(.caption).foregroundStyle(.secondary).padding(20)
        }
    }

    private func bindingSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("Binding") {
            Picker("", selection: Binding(
                get: { isPin(item.binding) ? "pin" : "follow" },
                set: { choice in
                    mutate { current in
                        if choice == "follow" {
                            current[index].binding = .followAttention
                        } else {
                            let provider = firstProvider()
                            current[index].binding = .pin(
                                provider: provider,
                                nativeWindowId: firstWindowId(of: provider))
                        }
                    }
                })) {
                Text("Follow attention").tag("follow")
                Text("Pin window").tag("pin")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private func providerSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("Provider") {
            Picker("", selection: Binding(
                get: { pinProvider(item.binding) ?? firstProvider() },
                set: { provider in
                    mutate { current in
                        current[index].binding = .pin(
                            provider: provider,
                            nativeWindowId: firstWindowId(of: provider))
                        current[index].scope = .provider(provider)
                    }
                })) {
                ForEach(catalogProviders(), id: \.self) { provider in
                    Text("\(agentShortCode(provider)) · \(agentDisplayName(provider))").tag(provider)
                }
            }
            .labelsHidden()
        }
    }

    private func windowSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        let provider = pinProvider(item.binding) ?? firstProvider()
        // only windows the source actually returned — never a fixed enum
        return section("Window · native id") {
            Picker("", selection: Binding(
                get: { pinWindowId(item.binding) ?? "" },
                set: { windowId in
                    mutate { $0[index].binding = .pin(provider: provider, nativeWindowId: windowId) }
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

    private func pairSection(_ item: MenuItemDescriptor, index: Int) -> some View {
        let provider = pinProvider(item.binding) ?? firstProvider()
        let pairSupported = supportsPairWindows(agent: provider, quota: quota)
        return section("Window set") {
            Toggle("5h + 7d pair", isOn: Binding(
                get: { item.windowSet == "pair" },
                set: { value in mutate { $0[index].windowSet = value ? "pair" : "single" } }))
                .disabled(!pairSupported)
            if !pairSupported {
                // the pair never gets synthesized from a missing window
                Text("\(agentDisplayName(provider)) does not return a 5h+7d pair right now. Daily/weekly-only stays a single rail.")
                    .font(.caption2).foregroundStyle(.orange)
            }
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

    private func identitySection(_ item: MenuItemDescriptor, index: Int) -> some View {
        section("Identity") {
            Picker("", selection: Binding(
                get: { item.providerIdentityPresentation ?? "icon" },
                set: { value in mutate { $0[index].providerIdentityPresentation = value } })) {
                Text("Icon").tag("icon")
                Text("Code").tag("vertical_text")
                Text("None · VO keeps name").tag("none")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
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
            case .consumedTokenHistory, .actualCostHistory:
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
                if case .success(let value) = result {
                    quota = value.quota
                    buckets = value.report.buckets
                }
            }
        }
        SidecarClient.shared.requestDecodable("todayByAgent", as: [String: Int].self) { result in
            DispatchQueue.main.async {
                if case .success(let value) = result { todayRows = value }
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
        windowIds(of: provider).first ?? "five_hour"
    }

    private func isQuotaMetric(_ metric: MenuItemMetric) -> Bool {
        metric == .quotaUsagePercentage || metric == .quotaReset || metric == .quotaMiniBar
    }

    private func isHistoryMetric(_ metric: MenuItemMetric) -> Bool {
        metric == .consumedTokenHistory || metric == .actualCostHistory
    }

    private func isPin(_ binding: ItemBinding?) -> Bool {
        if case .pin = binding { return true }
        return false
    }

    private func pinProvider(_ binding: ItemBinding?) -> String? {
        if case .pin(let provider, _) = binding { return provider }
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
        case .actualCostHistory: return "Actual cost"
        case .agentActive: return "Agent active"
        case .spacer: return "Spacer"
        }
    }

    private func itemSubtitle(_ item: MenuItemDescriptor) -> String {
        switch item.binding {
        case .followAttention: return "follows attention"
        case .pin(let provider, let windowId): return "\(provider) · \(windowId)"
        case nil:
            if case .provider(let provider) = item.scope { return provider }
            return "aggregate"
        }
    }
}

