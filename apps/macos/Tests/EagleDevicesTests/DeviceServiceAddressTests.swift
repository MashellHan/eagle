import CryptoKit
import Foundation
import Testing

@testable import EagleDevices

@Suite("Device service address")
struct DeviceServiceAddressTests {
  @Test(
    "a bare HTTPS origin is accepted and normalized",
    arguments: [
      ("https://devices.example.com", "https://devices.example.com"),
      ("https://DEVICES.example.com:443/", "https://devices.example.com"),
      ("  https://devices.example.com:8443  ", "https://devices.example.com:8443"),
      ("http://127.0.0.1:17053", "http://127.0.0.1:17053"),
      ("http://localhost:8080", "http://localhost:8080"),
    ])
  func accepts(argument: (String, String)) {
    #expect(DeviceServiceAddress.normalize(argument.0) == argument.1)
  }

  @Test(
    "anything but an origin is refused",
    arguments: [
      "", "   ", "devices.example.com", "ftp://devices.example.com",
      "http://devices.example.com", "https://devices.example.com/path",
      "https://devices.example.com?x=1", "https://devices.example.com#frag",
      "https://user:secret@devices.example.com",
    ])
  func refuses(value: String) {
    #expect(DeviceServiceAddress.normalize(value) == nil)
  }

  @Test("only the person's choice is stored, and a bad value clears it")
  func storesChoice() throws {
    let defaults = try #require(UserDefaults(suiteName: "ai.hexly.eagle.tests.address"))
    defer { defaults.removePersistentDomain(forName: "ai.hexly.eagle.tests.address") }
    #expect(DeviceServiceAddress.saved(defaults) == nil)
    #expect(
      DeviceServiceAddress.save("https://Devices.Example.com:443/", defaults: defaults) != nil)
    #expect(DeviceServiceAddress.saved(defaults) == "https://devices.example.com")
    #expect(DeviceServiceAddress.save("not-an-origin", defaults: defaults) == nil)
    #expect(DeviceServiceAddress.saved(defaults) == nil)
  }

  @Test(
    "invalid profiles have no address store", arguments: ["", String(repeating: "x", count: 81)])
  func invalidProfile(profile: String) {
    #expect(DeviceServiceAddress.save("https://refused.example.com", profile: profile) == nil)
    #expect(DeviceServiceAddress.saved(profile: profile) == nil)
  }

  @Test("system control exposes only its validated bundle profile without starting a helper")
  @MainActor func boundProfile() throws {
    let bundle = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: bundle) }
    #expect(DeviceSystemControl(bundle: bundle).serviceProfile == nil)
    let resources = bundle.appendingPathComponent("Contents/Resources")
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    for profile in ["address-owned-" + UUID().uuidString, "", String(repeating: "x", count: 81)] {
      let config = DeviceHostConfiguration(
        version: 1, profile: profile, baseUrl: "",
        machServiceName: "ai.hexly.eagle.devices.test",
        launchAgentPlist: "ai.hexly.eagle.devices.test.plist")
      try JSONEncoder().encode(config).write(
        to: resources.appendingPathComponent("DeviceHost.json"))
      #expect(
        DeviceSystemControl(bundle: bundle).serviceProfile
          == (profile.hasPrefix("address-owned-") ? profile : nil))
    }
  }

  @Test("a configuration with no origin is unconfigured, not invalid")
  func unconfiguredBundle() throws {
    var config = DeviceHostConfiguration(
      version: 1, profile: "device-release", baseUrl: "",
      machServiceName: "ai.hexly.eagle.devices",
      launchAgentPlist: "ai.hexly.eagle.devices.plist")
    #expect(!config.isConfigured)
    try config.validate()
    config.baseUrl = "https://devices.example.com"
    #expect(config.isConfigured)
    #expect(config.serviceOrigin == "https://devices.example.com")
    try config.validate()
  }

  @Test("validated control imports a legacy App choice once, preserving the original bytes")
  @MainActor func legacyUpgrade() throws {
    let fixture = try AddressUpgradeFixture()
    defer { fixture.remove() }
    let raw = "  https://Legacy.Example.com:443/  "
    fixture.legacy.set(raw, forKey: DeviceServiceAddress.defaultsKey)
    #expect(fixture.control().serviceProfile == fixture.profile)
    #expect(DeviceServiceAddress.saved(profile: fixture.profile) == "https://legacy.example.com")
    #expect(fixture.legacy.string(forKey: DeviceServiceAddress.defaultsKey) == raw)
    fixture.legacy.set("https://changed.example.com", forKey: DeviceServiceAddress.defaultsKey)
    _ = fixture.control()
    #expect(DeviceServiceAddress.saved(profile: fixture.profile) == "https://legacy.example.com")
    let other = try AddressUpgradeFixture()
    defer { other.remove() }
    other.legacy.set("https://other.example.com", forKey: DeviceServiceAddress.defaultsKey)
    _ = other.control()
    #expect(DeviceServiceAddress.saved(profile: other.profile) == "https://other.example.com")
    #expect(DeviceServiceAddress.saved(profile: fixture.profile) == "https://legacy.example.com")
  }

  @Test("raw profile decisions win, and clearing never resurrects a legacy choice")
  @MainActor func profileDecisions() throws {
    let fixture = try AddressUpgradeFixture()
    defer { fixture.remove() }
    fixture.legacy.set("https://legacy.example.com", forKey: DeviceServiceAddress.defaultsKey)
    for raw in ["https://profile.example.com", "not-an-origin"] {
      fixture.profileDefaults.set(raw, forKey: DeviceServiceAddress.defaultsKey)
      _ = fixture.control()
      #expect(fixture.profileDefaults.string(forKey: DeviceServiceAddress.defaultsKey) == raw)
    }
    DeviceServiceAddress.save("", profile: fixture.profile)
    _ = fixture.control()
    #expect(DeviceServiceAddress.saved(profile: fixture.profile) == nil)
    #expect(
      fixture.legacy.string(forKey: DeviceServiceAddress.defaultsKey)
        == "https://legacy.example.com")
    let cleared = try AddressUpgradeFixture()
    defer { cleared.remove() }
    cleared.legacy.set("https://old.example.com", forKey: DeviceServiceAddress.defaultsKey)
    DeviceServiceAddress.save("", profile: cleared.profile)
    _ = cleared.control()
    #expect(DeviceServiceAddress.saved(profile: cleared.profile) == nil)
  }

  @Test(
    "missing and invalid legacy choices are handled without importing or later resurrection",
    arguments: [nil, "not-an-origin"] as [String?])
  @MainActor func unusableLegacy(raw: String?) throws {
    let fixture = try AddressUpgradeFixture()
    defer { fixture.remove() }
    if let raw { fixture.legacy.set(raw, forKey: DeviceServiceAddress.defaultsKey) }
    _ = fixture.control()
    #expect(DeviceServiceAddress.saved(profile: fixture.profile) == nil)
    fixture.legacy.set("https://late.example.com", forKey: DeviceServiceAddress.defaultsKey)
    _ = fixture.control()
    #expect(DeviceServiceAddress.saved(profile: fixture.profile) == nil)
  }

  @Test("invalid bundle configuration cannot import a valid legacy choice")
  @MainActor func invalidUpgrade() throws {
    let fixture = try AddressUpgradeFixture()
    defer { fixture.remove() }
    fixture.legacy.set("https://legacy.example.com", forKey: DeviceServiceAddress.defaultsKey)
    try Data("{}".utf8).write(
      to: fixture.bundle.appendingPathComponent("Contents/Resources/DeviceHost.json"))
    #expect(fixture.control().serviceProfile == nil)
    #expect(fixture.profileDefaults.persistentDomain(forName: fixture.profileDomain) == nil)
  }

  @Test(
    "production legacy domains require the exact published bundle and profile pair",
    arguments: [
      ("device-release", "ai.hexly.eagle.macos", "ai.hexly.eagle.macos"),
      (
        "device-candidate", "ai.hexly.eagle.macos.device-candidate",
        "ai.hexly.eagle.macos.device-candidate"
      ),
      ("device-release", "ai.hexly.eagle.macos.device-candidate", nil),
      ("device-candidate", "ai.hexly.eagle.macos", nil),
      ("custom-profile", "ai.hexly.eagle.macos", nil),
      ("custom-profile", "ai.hexly.eagle.macos.device-candidate", nil),
      ("device-release", nil, nil),
    ] as [(String, String?, String?)])
  @MainActor func legacyDomain(pair: (String, String?, String?)) {
    #expect(DeviceSystemControl.legacyAppDomain(profile: pair.0, identifier: pair.1) == pair.2)
  }
}

@MainActor private struct AddressUpgradeFixture {
  let profile = "upgrade-" + UUID().uuidString
  let bundle = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let legacyDomain = "address-legacy-" + UUID().uuidString
  let profileDomain: String
  let legacy: UserDefaults
  let profileDefaults: UserDefaults

  init() throws {
    let digest = SHA256.hash(data: Data(profile.utf8)).map { String(format: "%02x", $0) }.joined()
    profileDomain = "ai.hexly.eagle.devices.address." + digest
    legacy = try #require(UserDefaults(suiteName: legacyDomain))
    profileDefaults = try #require(UserDefaults(suiteName: profileDomain))
    let resources = bundle.appendingPathComponent("Contents/Resources")
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    let config = DeviceHostConfiguration(
      version: 1, profile: profile, baseUrl: "",
      machServiceName: "ai.hexly.eagle.devices.test",
      launchAgentPlist: "ai.hexly.eagle.devices.test.plist")
    try JSONEncoder().encode(config).write(to: resources.appendingPathComponent("DeviceHost.json"))
  }

  func control() -> DeviceSystemControl {
    DeviceSystemControl(bundle: bundle, defaults: legacy, legacyDefaults: legacy)
  }
  func remove() {
    legacy.removePersistentDomain(forName: legacyDomain)
    profileDefaults.removePersistentDomain(forName: profileDomain)
    try? FileManager.default.removeItem(at: bundle)
  }
}
