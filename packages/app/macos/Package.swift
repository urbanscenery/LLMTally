// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "LLMTallyBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "LLMTallyBar", path: "Sources/LLMTallyBar")
    ]
)
