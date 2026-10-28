import Foundation

public struct BotCredentialHelper: BotRemoteCredentialAccess {
  public let executable: URL
  public init(executable: URL) { self.executable = executable }
  public static func discover(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    bundle: URL = Bundle.main.bundleURL
  ) -> BotCredentialHelper? {
    let path =
      environment["BOTS_CREDENTIAL_HELPER"]
      ?? bundle.appendingPathComponent("Contents/Helpers/BotsCredentialHelper").path
    guard path.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: path) else {
      return nil
    }
    return BotCredentialHelper(executable: URL(fileURLWithPath: path))
  }
  public func put(_ binding: BotRemoteCredentialBinding, connection: MachineConnection) async throws
  {
    guard binding.origin == connection.origin.absoluteString,
      binding.namespace.range(of: "^[a-f0-9]{64}$", options: .regularExpression)
        == binding.namespace.startIndex..<binding.namespace.endIndex,
      identifier(binding.botId, maximum: 80), identifier(binding.credentialRef, maximum: 120),
      binding.credentialRef.count >= 8,
      ![binding.namespace, binding.botId, binding.credentialRef, binding.origin]
        .contains(where: connection.containsCredential)
    else { throw BotRemoteGrantError.invalid }
    struct Input: Encodable {
      let action = "put"
      let binding: BotRemoteCredentialBinding
      let ownerToken: String
      let accessClientID: String?
      let accessClientSecret: String?
    }
    let data = try JSONEncoder().encode(
      Input(
        binding: binding, ownerToken: connection.ownerToken,
        accessClientID: connection.accessClientID, accessClientSecret: connection.accessClientSecret
      ))
    do {
      let result = try await Task.detached(priority: .userInitiated) {
        try LocalPrivateProcess.runBlocking(
          executable: executable, arguments: [],
          environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"], input: data)
      }.value
      guard let reply = try JSONSerialization.jsonObject(with: result) as? [String: Any],
        Set(reply.keys) == ["available"], let available = reply["available"] as? NSNumber,
        CFGetTypeID(available) == CFBooleanGetTypeID(), available.boolValue
      else { throw BotRemoteGrantError.needsLocal }
    } catch { throw BotRemoteGrantError.needsLocal }
  }
  private func identifier(_ value: String, maximum: Int) -> Bool {
    value.range(of: "^[A-Za-z0-9_-]{1,\(maximum)}$", options: .regularExpression)
      == value.startIndex..<value.endIndex
  }
}
