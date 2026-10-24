// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Eagle",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "EagleApp", targets: ["EagleApp"])
  ],
  targets: [
    .target(name: "EagleDesign"),
    .target(name: "EagleFeatures", dependencies: ["EagleDesign"]),
    .executableTarget(
      name: "EagleApp",
      dependencies: ["EagleDesign", "EagleFeatures"]
    ),
    .executableTarget(
      name: "SnapshotRenderer",
      dependencies: ["EagleDesign", "EagleFeatures"]
    ),
    // XCTest ships only with full Xcode and Swift Testing's macro plugin does
    // not load under a Command Line Tools-only toolchain, so the checks run as
    // a plain executable: `swift run EagleChecks`.
    .executableTarget(
      name: "EagleChecks",
      dependencies: ["EagleDesign", "EagleFeatures"]
    ),
  ]
)
