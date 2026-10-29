import Foundation
import LocalAuthentication
import Security

private enum Refused: Error { case invalid }

private struct Binding: Codable, Equatable {
  let namespace: String
  let botId: String
  let credentialRef: String
  let origin: String

  init(_ raw: Any?) throws {
    guard let value = raw as? [String: String],
      Set(value.keys) == ["namespace", "botId", "credentialRef", "origin"],
      let namespace = value["namespace"],
      namespace.range(of: "^[a-f0-9]{64}$", options: .regularExpression)
        == namespace.startIndex..<namespace.endIndex,
      let bot = value["botId"], Self.identifier(bot, maximum: 80),
      let reference = value["credentialRef"], Self.identifier(reference, maximum: 120),
      reference.count >= 8,
      let origin = value["origin"], origin.utf8.count <= 2048,
      let parts = URLComponents(string: origin), let host = parts.host,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      parts.path.isEmpty, parts.port.map({ (1...65535).contains($0) }) ?? true,
      parts.scheme == "https"
        || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
      host == host.lowercased(), parts.url?.absoluteString == origin
    else { throw Refused.invalid }
    self.namespace = namespace
    botId = bot
    credentialRef = reference
    self.origin = origin
  }
  static func identifier(_ value: String, maximum: Int) -> Bool {
    value.range(of: "^[a-zA-Z0-9_-]{1,\(maximum)}$", options: .regularExpression)
      == value.startIndex..<value.endIndex
  }
  var account: String { namespace + ":" + botId + ":" + credentialRef }
}

private struct Credential: Codable {
  let binding: Binding
  let ownerToken: String
  let accessClientID: String?
  let accessClientSecret: String?

  init(binding: Binding, input: [String: Any]) throws {
    guard let owner = input["ownerToken"] as? String, Self.secret(owner, minimum: 32) else {
      throw Refused.invalid
    }
    let accessID = input["accessClientID"] as? String
    let accessSecret = input["accessClientSecret"] as? String
    guard (input["accessClientID"] == nil) == (accessID == nil),
      (input["accessClientSecret"] == nil) == (accessSecret == nil),
      (accessID == nil && accessSecret == nil)
        || (accessID.map({ Self.secret($0, minimum: 1) }) == true
          && accessSecret.map({ Self.secret($0, minimum: 1) }) == true)
    else { throw Refused.invalid }
    self.binding = binding
    ownerToken = owner
    accessClientID = accessID
    accessClientSecret = accessSecret
  }
  static func secret(_ value: String, minimum: Int) -> Bool {
    (minimum...8192).contains(value.utf8.count)
      && value.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil
  }
}

private struct Vault {
  let binding: Binding
  func query() -> [String: Any] {
    let context = LAContext()
    context.interactionNotAllowed = true
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "ai.hexly.bots.remote-credentials",
      kSecAttrAccount as String: binding.account,
      kSecAttrSynchronizable as String: false,
      kSecUseAuthenticationContext as String: context,
    ]
  }
  func read() throws -> Credential? {
    var request = query()
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, data.count <= 65536,
      let value = try? JSONDecoder().decode(Credential.self, from: data), value.binding == binding,
      let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw Refused.invalid }
    return try Credential(binding: binding, input: raw)
  }
  private func mutationQuery() -> [String: Any] {
    var request = query()
    request[kSecAttrGeneric as String] = Data(binding.origin.utf8)
    return request
  }
  func put(_ value: Credential) throws {
    let existing = try read()
    let data = try JSONEncoder().encode(value)
    let status: OSStatus
    if existing != nil {
      status = SecItemUpdate(
        mutationQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    } else {
      var request = mutationQuery()
      request[kSecValueData as String] = data
      request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(request as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw Refused.invalid }
  }
  func remove() throws {
    guard try read() != nil else { return }
    guard SecItemDelete(mutationQuery() as CFDictionary) == errSecSuccess else {
      throw Refused.invalid
    }
  }
}

@main enum BotsCredentialHelper {
  static func main() {
    do {
      guard CommandLine.arguments.count == 1 else { throw Refused.invalid }
      var data = Data()
      while let part = try FileHandle.standardInput.read(upToCount: 65537 - data.count),
        !part.isEmpty
      {
        data.append(part)
        guard data.count <= 65536 else { throw Refused.invalid }
      }
      guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let action = input["action"] as? String,
        ["put", "read", "status", "remove"].contains(action)
      else { throw Refused.invalid }
      let allowed: Set<String> =
        action == "put"
        ? ["action", "binding", "ownerToken", "accessClientID", "accessClientSecret"]
        : ["action", "binding"]
      guard Set(input.keys).isSubset(of: allowed) else { throw Refused.invalid }
      let binding = try Binding(input["binding"])
      let vault = Vault(binding: binding)
      let output: Data
      switch action {
      case "put":
        try vault.put(Credential(binding: binding, input: input))
        output = Data("{\"available\":true}".utf8)
      case "read":
        guard let credential = try vault.read() else { throw Refused.invalid }
        output = try JSONEncoder().encode(credential)
      case "remove":
        try vault.remove()
        output = Data("{\"available\":false}".utf8)
      default:
        output = Data(
          (try vault.read() == nil ? "{\"available\":false}" : "{\"available\":true}").utf8)
      }
      guard output.count <= 65536 else { throw Refused.invalid }
      FileHandle.standardOutput.write(output)
      FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
      FileHandle.standardError.write(Data("needs_local\n".utf8))
      exit(1)
    }
  }
}
