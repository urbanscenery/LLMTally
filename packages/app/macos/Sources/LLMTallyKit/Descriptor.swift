import Foundation

/// `menuBarBuilderV1` — the ordered descriptor array that is the only
/// canon for what the status item shows (03_design_spec §6.2). The JSON
/// shape matches the TypeScript contract byte-for-byte so a future
/// Builder UI and this renderer share one store.

public enum MenuItemMetric: String, Codable {
    case providerLabel = "provider_label"
    case quotaUsagePercentage = "quota_usage_percentage"
    case quotaMiniBar = "quota_mini_bar"
    case consumedTokenHistory = "consumed_token_history"
    case quotaCostHistory = "quota_cost_history"
    case quotaReset = "quota_reset"
    case sourceFreshness = "source_freshness"
    case agentActive = "agent_active"
    case spacer

    /// Loud migration, not a silent alias: earlier saves stored
    /// `actual_cost_history` (pre-billing-nature) or
    /// `usage_cost_history` (billing-nature round 1) — both name the
    /// same quota-valued spark, so they decode into the quota-cost
    /// metric instead of failing the whole preferences blob.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        if raw == "actual_cost_history" || raw == "usage_cost_history" {
            self = .quotaCostHistory
            return
        }
        guard let value = MenuItemMetric(rawValue: raw) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "unknown menu item metric \"\(raw)\""))
        }
        self = value
    }
}

public enum MenuItemScope: Codable, Equatable {
    case aggregate
    case provider(String)

    private enum CodingKeys: String, CodingKey { case kind, provider }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        if kind == "provider" {
            self = .provider(try container.decode(String.self, forKey: .provider))
        } else {
            self = .aggregate
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .aggregate:
            try container.encode("aggregate", forKey: .kind)
        case .provider(let provider):
            try container.encode("provider", forKey: .kind)
            try container.encode(provider, forKey: .provider)
        }
    }
}

/// quota 계열 전용: follow attention, or pin one native window.
public enum ItemBinding: Codable, Equatable {
    case followAttention
    case pin(provider: String, nativeWindowId: String)

    private enum CodingKeys: String, CodingKey { case kind, provider, nativeWindowId }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        if kind == "pin" {
            self = .pin(
                provider: try container.decode(String.self, forKey: .provider),
                nativeWindowId: try container.decode(String.self, forKey: .nativeWindowId))
        } else {
            self = .followAttention
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .followAttention:
            try container.encode("follow_attention", forKey: .kind)
        case .pin(let provider, let nativeWindowId):
            try container.encode("pin", forKey: .kind)
            try container.encode(provider, forKey: .provider)
            try container.encode(nativeWindowId, forKey: .nativeWindowId)
        }
    }
}

public struct MenuItemDescriptor: Codable, Identifiable, Equatable {
    public let id: String
    public var scope: MenuItemScope
    public var metric: MenuItemMetric
    public var presentation: String
    public var direction: String?
    public var timeRange: String?
    public var resetDisplay: String?
    public var showRangeLabel: Bool?
    public var showWindowLabel: Bool?
    public var showPercentage: Bool?
    public var binding: ItemBinding?
    public var windowSet: String?
    /// Rails only: an optional second native window — one rail when nil,
    /// two when set. Supersedes the fixed `windowSet == "pair"`.
    public var secondNativeWindowId: String?
    public var providerIdentityPresentation: String?
    public var unavailableBehavior: String

    public init(id: String = UUID().uuidString,
                scope: MenuItemScope,
                metric: MenuItemMetric,
                presentation: String = "text",
                direction: String? = nil,
                timeRange: String? = nil,
                resetDisplay: String? = nil,
                showRangeLabel: Bool? = true,
                showWindowLabel: Bool? = true,
                showPercentage: Bool? = true,
                binding: ItemBinding? = nil,
                windowSet: String? = nil,
                secondNativeWindowId: String? = nil,
                providerIdentityPresentation: String? = "icon",
                unavailableBehavior: String = "placeholder") {
        self.id = id
        self.scope = scope
        self.metric = metric
        self.presentation = presentation
        self.direction = direction
        self.timeRange = timeRange
        self.resetDisplay = resetDisplay
        self.showRangeLabel = showRangeLabel
        self.showWindowLabel = showWindowLabel
        self.showPercentage = showPercentage
        self.binding = binding
        self.windowSet = windowSet
        self.secondNativeWindowId = secondNativeWindowId
        self.providerIdentityPresentation = providerIdentityPresentation
        self.unavailableBehavior = unavailableBehavior
    }
}

public struct MenuBarBuilderPreferences: Codable, Equatable {
    public var version: Int
    public var items: [MenuItemDescriptor]

    public init(version: Int = 1, items: [MenuItemDescriptor]) {
        self.version = version
        self.items = items
    }
}

/// Factory Auto — seeded exactly once on first run; afterwards the
/// array is plain user data (no persistent preset control). Every
/// quota item pins a window (follow-attention is retired; the enum
/// case survives only to decode legacy saves).
public func autoFactoryItems() -> [MenuItemDescriptor] {
    [
        MenuItemDescriptor(
            scope: .provider("claude-code"),
            metric: .quotaUsagePercentage,
            direction: "used",
            binding: .pin(provider: "claude-code", nativeWindowId: "five_hour")),
        MenuItemDescriptor(
            scope: .aggregate,
            metric: .sourceFreshness,
            providerIdentityPresentation: nil),
    ]
}

/// UserDefaults persistence for the descriptor array. SQLite is
/// observation data, never a UI-order store.
public final class DescriptorStore {
    public static let storageKey = "menuBarBuilderV1"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> [MenuItemDescriptor] {
        guard
            let data = defaults.data(forKey: Self.storageKey),
            let preferences = try? JSONDecoder().decode(MenuBarBuilderPreferences.self, from: data),
            !preferences.items.isEmpty
        else {
            let seeded = autoFactoryItems()
            save(seeded)
            return seeded
        }
        return preferences.items
    }

    public func save(_ items: [MenuItemDescriptor]) {
        let preferences = MenuBarBuilderPreferences(items: items)
        if let data = try? JSONEncoder().encode(preferences) {
            defaults.set(data, forKey: Self.storageKey)
        }
    }
}
