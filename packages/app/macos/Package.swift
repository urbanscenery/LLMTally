// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "LLMTallyBar",
    platforms: [.macOS(.v13)],
    targets: [
        // Pure logic (DTOs, attention ranking, descriptors, status
        // renderer) — no AppKit, so it is verifiable headlessly.
        .target(name: "LLMTallyKit", path: "Sources/LLMTallyKit"),
        .executableTarget(
            name: "LLMTallyBar",
            dependencies: ["LLMTallyKit"],
            path: "Sources/LLMTallyBar"),
        // Assert-based checks runnable with Command Line Tools alone:
        // `swift run kit-selftest` (XCTest needs a licensed full Xcode,
        // which a dev box may not have).
        .executableTarget(
            name: "kit-selftest",
            dependencies: ["LLMTallyKit"],
            path: "Sources/KitSelftest"),
    ]
)
