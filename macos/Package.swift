// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GPTNiangMac",
    defaultLocalization: "zh-Hans",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "GPTNiangMac", targets: ["GPTNiangMac"]),
               .executable(name: "GPTNiangUpdater", targets: ["GPTNiangUpdater"])],
    targets: [
        .target(name: "GPTNiangCore", resources: [.process("Resources")]),
        .target(name: "GPTNiangUpdate"),
        .executableTarget(name: "GPTNiangMac", dependencies: ["GPTNiangCore", "GPTNiangUpdate"]),
        .executableTarget(name: "GPTNiangUpdater", dependencies: ["GPTNiangUpdate"]),
        .testTarget(name: "GPTNiangUpdateTests", dependencies: ["GPTNiangUpdate"]),
        .testTarget(name: "GPTNiangCoreTests", dependencies: ["GPTNiangCore"]),
        .testTarget(name: "GPTNiangMacTests", dependencies: ["GPTNiangMac"])
    ]
)
