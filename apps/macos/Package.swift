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
    .testTarget(name: "EagleDesignTests", dependencies: ["EagleDesign"]),
    .testTarget(name: "EagleFeaturesTests", dependencies: ["EagleFeatures"]),
  ]
)
