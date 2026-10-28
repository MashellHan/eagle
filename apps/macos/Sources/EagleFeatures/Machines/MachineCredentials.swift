import Foundation
import LocalAuthentication
import Security

@MainActor
public protocol MachineCredentialVault: AnyObject {
  func load() throws -> MachineConnection?
  func save(_ connection: MachineConnection) throws
  func remove() throws
}

/// One atomic, device-local item contains both the origin and its credentials.
@MainActor
public final class KeychainMachineCredentials: MachineCredentialVault {
  private let service: String
  public init(service: String = "ai.hexly.eagle.machine-access") { self.service = service }
  private var query: [String: Any] {
    let context = LAContext()
    context.interactionNotAllowed = true
    return [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "deployment-owner", kSecAttrSynchronizable as String: false,
      kSecUseAuthenticationContext as String: context,
    ]
  }

  public func load() throws -> MachineConnection? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw MachineAccessError.keychain(status) }
    guard let data = result as? Data, data.count <= 65_536 else {
      throw MachineAccessError.invalidCredential
    }
    do { return try JSONDecoder().decode(MachineConnection.self, from: data) } catch {
      throw MachineAccessError.invalidCredential
    }
  }

  public func save(_ connection: MachineConnection) throws {
    let data = try JSONEncoder().encode(connection)
    let attributes = [kSecValueData as String: data] as CFDictionary
    var status = SecItemUpdate(query as CFDictionary, attributes)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw MachineAccessError.keychain(status) }
  }

  public func remove() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw MachineAccessError.keychain(status)
    }
  }
}
