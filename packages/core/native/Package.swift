// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "LLMTallyKeychain",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "llmtally-keychain", targets: ["LLMTallyKeychain"]),
    ],
    targets: [
        .executableTarget(
            name: "LLMTallyKeychain",
            linkerSettings: [
                .linkedFramework("LocalAuthentication"),
                .linkedFramework("Security"),
            ]
        ),
    ]
)
