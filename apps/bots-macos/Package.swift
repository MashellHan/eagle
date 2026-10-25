// swift-tools-version: 6.0
import PackageDescription

/// The Bots client logic: domain, transport and view models. The UI lives in the Eagle app
/// (`apps/macos/Sources/EagleBots`), which depends on this package; nothing here depends on
/// Eagle, so there is no cycle (docs/bots/ARCHITECTURE.md, "Isolation").
let package = Package(
  name: "Bots",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "BotsCore", targets: ["BotsCore"]),
    .library(name: "BotsTransport", targets: ["BotsTransport"]),
    .library(name: "BotsFeatures", targets: ["BotsFeatures"]),
  ],
  targets: [
    .target(name: "BotsCore"),
    .target(name: "BotsTransport", dependencies: ["BotsCore"]),
    .target(name: "BotsFeatures", dependencies: ["BotsCore", "BotsTransport"]),
    .testTarget(name: "BotsCoreTests", dependencies: ["BotsCore", "BotsTransport"]),
    .testTarget(name: "BotsTransportTests", dependencies: ["BotsTransport"]),
    .testTarget(name: "BotsFeaturesTests", dependencies: ["BotsFeatures"]),
  ],
  swiftLanguageModes: [.v5]
)
