// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Eagle",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "EagleApp", targets: ["EagleApp"]),
    // Tokens and primitives, dependent on nothing (docs/bots/ARCHITECTURE.md).
    .library(name: "EagleDesign", targets: ["EagleDesign"]),
  ],
  dependencies: [
    .package(path: "../bots-macos")
  ],
  targets: [
    .target(name: "EagleDesign", resources: [.process("Resources")]),
    // Bots lives in the shell: its view model and publisher are part of EagleFeatures,
    // and its logic is the separate Bots package (docs/bots/PLAN.md, stage 5).
    .target(
      name: "EagleFeatures",
      dependencies: [
        "EagleDesign",
        .product(name: "BotsCore", package: "bots-macos"),
        .product(name: "BotsTransport", package: "bots-macos"),
        .product(name: "BotsFeatures", package: "bots-macos"),
      ]
    ),
    .executableTarget(
      name: "EagleApp",
      dependencies: ["EagleDesign", "EagleFeatures"]
    ),
    .executableTarget(
      name: "SnapshotRenderer",
      dependencies: ["EagleDesign", "EagleFeatures"]
    ),
    .testTarget(name: "EagleDesignTests", dependencies: ["EagleDesign"]),
    .testTarget(name: "EagleFeaturesTests", dependencies: ["EagleFeatures"]),
  ]
)
