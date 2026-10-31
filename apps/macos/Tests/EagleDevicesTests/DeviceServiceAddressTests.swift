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

  @Test("the helper reads the App's domain, not its own")
  func readsAppDomain() throws {
    let suite = "ai.hexly.eagle.tests.appdomain"
    let other = try #require(UserDefaults(suiteName: suite))
    defer { other.removePersistentDomain(forName: suite) }
    #expect(DeviceServiceAddress.saved(forBundle: suite) == nil)
    other.set("https://Devices.Example.com/", forKey: DeviceServiceAddress.defaultsKey)
    #expect(DeviceServiceAddress.saved(forBundle: suite) == "https://devices.example.com")
    // An unusable stored value never becomes an address.
    other.set("not-an-origin", forKey: DeviceServiceAddress.defaultsKey)
    #expect(DeviceServiceAddress.saved(forBundle: suite) == nil)
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
}
