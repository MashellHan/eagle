import Foundation
import Testing

@testable import EagleDevices

@Suite("Bundled helper path")
struct DeviceHelperPathTests {
  private let prefix = "Contents/Library/LaunchServices/EagleDeviceHelper"

  private func fixture(program: String) throws -> (URL, DeviceHostConfiguration) {
    let bundle = FileManager.default.temporaryDirectory.appendingPathComponent(
      "helper-path-\(UUID().uuidString).app")
    let agents = bundle.appendingPathComponent("Contents/Library/LaunchAgents")
    try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
    for (path, value) in [
      ("Contents/Info.plist", ["CFBundleVersion": "1793336081495"]),
      (
        "Contents/Library/LaunchAgents/ai.hexly.eagle.devices.candidate.plist",
        ["BundleProgram": program]
      ),
    ] {
      try PropertyListSerialization.data(fromPropertyList: value, format: .xml, options: 0)
        .write(to: bundle.appendingPathComponent(path))
    }
    let config = try JSONDecoder().decode(
      DeviceHostConfiguration.self,
      from: Data(
        #"{"version":1,"profile":"device-candidate","baseUrl":"http://127.0.0.1:1","machServiceName":"ai.hexly.eagle.devices.candidate","launchAgentPlist":"ai.hexly.eagle.devices.candidate.plist"}"#
          .utf8))
    return (bundle, config)
  }

  @Test(
    "uses the exact current-build or legacy helper named by the launch plist",
    arguments: ["", ".1793336081495"])
  func currentHelper(suffix: String) throws {
    let program = prefix + suffix
    let (bundle, config) = try fixture(program: program)
    defer { try? FileManager.default.removeItem(at: bundle) }
    #expect(try config.helperURL(bundle: bundle) == bundle.appendingPathComponent(program))
  }

  @Test(
    "rejects another build or a path outside the bundled helper",
    arguments: [
      "Contents/Library/LaunchServices/EagleDeviceHelper.1793336081496",
      "Contents/Library/LaunchServices/../../../../other",
      "/tmp/EagleDeviceHelper",
      "Contents/Library/LaunchServices/OtherHelper",
    ])
  func rejectsUnexpectedHelper(program: String) throws {
    let (bundle, config) = try fixture(program: program)
    defer { try? FileManager.default.removeItem(at: bundle) }
    #expect(throws: DeviceHostError.invalidConfiguration) {
      try config.helperURL(bundle: bundle)
    }
  }
}
