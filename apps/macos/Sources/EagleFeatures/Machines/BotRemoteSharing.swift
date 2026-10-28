import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// A durable, non-secret cleanup marker, separate from the copied Bot credential.
@MainActor public final class KeychainBotRemoteSharingStore: BotRemoteSharingStore {
  private let account: String
  private let service: String
  public init(root: URL, service: String = "ai.hexly.eagle.machine-access") {
    self.service = service
    let path = root.standardizedFileURL.resolvingSymlinksInPath().path
    account =
      "shared-bots-"
      + SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private var query: [String: Any] {
    let context = LAContext()
    context.interactionNotAllowed = true
    return [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false,
      kSecUseAuthenticationContext as String: context,
    ]
  }
  private func origins() throws -> Set<String> {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let data = result as? Data, data.count <= 65_536,
      let values = try? JSONDecoder().decode([String].self, from: data),
      values.count <= 128, values.allSatisfy(Self.validOrigin)
    else { throw BotRemoteGrantError.needsLocal }
    return Set(values)
  }
  public func contains(origin: String) throws -> Bool { try origins().contains(origin) }
  public func remember(origin: String) throws {
    guard Self.validOrigin(origin) else { throw BotRemoteGrantError.invalid }
    var values = try origins()
    values.insert(origin)
    guard values.count <= 128 else { throw BotRemoteGrantError.needsLocal }
    try write(values)
  }
  public func forget(origin: String) throws {
    var values = try origins()
    values.remove(origin)
    try write(values)
  }
  private func write(_ values: Set<String>) throws {
    if values.isEmpty {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw BotRemoteGrantError.needsLocal
      }
      return
    }
    let data = try JSONEncoder().encode(values.sorted())
    guard data.count <= 65_536 else { throw BotRemoteGrantError.needsLocal }
    var status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw BotRemoteGrantError.needsLocal }
  }
  private static func validOrigin(_ value: String) -> Bool {
    guard value.utf8.count <= 2048, let parts = URLComponents(string: value),
      let host = parts.host, parts.path.isEmpty, parts.user == nil, parts.password == nil,
      parts.query == nil, parts.fragment == nil,
      parts.port.map({ (1...65535).contains($0) }) ?? true,
      parts.scheme == "https"
        || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
      parts.url?.absoluteString == value
    else { return false }
    return true
  }
}
