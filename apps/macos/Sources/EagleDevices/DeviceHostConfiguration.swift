import CryptoKit
import Darwin
import Foundation

public struct DeviceHostConfiguration: Codable, Sendable {
  public let version: Int
  public let profile: String
  public let baseUrl: String
  public let machServiceName: String
  public let launchAgentPlist: String

  public static func load(bundle: URL = Bundle.main.bundleURL) throws -> Self {
    let url = bundle.appendingPathComponent("Contents/Resources/DeviceHost.json")
    let result = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    try result.validate()
    return result
  }
  public func validate() throws {
    guard version == 1, !profile.isEmpty, profile.utf8.count <= 80,
      let url = URLComponents(string: baseUrl), url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
      url.host != nil,
      url.scheme == "https"
        || (url.scheme == "http" && ["127.0.0.1", "localhost", "[::1]"].contains(url.host ?? "")),
      machServiceName.hasPrefix("ai.hexly.eagle.devices."),
      launchAgentPlist == machServiceName + ".plist"
    else { throw DeviceHostError.invalidConfiguration }
  }
  public var serviceOrigin: String { baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl }
  public var stateDirectory: URL {
    let name = SHA256.hash(data: Data(profile.utf8)).prefix(8).map { String(format: "%02x", $0) }
      .joined()
    return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(
      ".eagle-devices/\(name)", isDirectory: true)
  }
  public var socketPath: String { stateDirectory.appendingPathComponent("access.sock").path }

  /// Only the running kernel can supply reboot proof; absence never becomes a random ID.
  public static func bootSessionID() -> String? {
    var size = 0
    guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0, size < 128 else {
      return nil
    }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0 else { return nil }
    let value = String(
      decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    return UUID(uuidString: value)?.uuidString.lowercased()
  }
}

public enum DeviceHostError: String, Error, Sendable {
  case invalidConfiguration = "invalid_configuration"
  case unavailable = "device_service_unavailable"
  case invalidResponse = "invalid_device_response"
  case timeout = "device_service_timeout"
  case forbidden = "device_method_forbidden"
  case failed = "device_request_failed"
}

public struct DevicePortError: Error, Sendable {
  public let code: String
  public init(_ code: String) {
    self.code =
      code.range(of: "^[a-z][a-z0-9_]{0,80}$", options: .regularExpression) == nil
      ? "device_request_failed" : code
  }
}
