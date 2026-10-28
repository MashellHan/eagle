import Foundation
import Testing

@testable import EagleFeatures

@Suite("Native credential bridge", .serialized)
@MainActor
struct BotCredentialBridgeTests {
  @Test func sharingMarkerIsDurableAndRemovingOneOriginPreservesTheOther() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let service = "ai.hexly.eagle.sharing-fixture.\(UUID().uuidString)"
    let first = KeychainBotRemoteSharingStore(root: root, service: service)
    let other = KeychainBotRemoteSharingStore(root: root, service: service)
    let a = "https://first.example.test"
    let b = "https://second.example.test"
    defer {
      try? first.forget(origin: a)
      try? first.forget(origin: b)
    }
    #expect(try !first.contains(origin: a))
    try first.remember(origin: a)
    try other.remember(origin: b)
    #expect(try other.contains(origin: a))
    try first.forget(origin: a)
    #expect(try !other.contains(origin: a))
    #expect(try other.contains(origin: b))
    try other.forget(origin: b)
    #expect(try !first.contains(origin: b))
  }

  @Test func helperReceivesCredentialsOnlyOnPrivateStdinAndMustConfirmTheWrite() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eagle-private-helper-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let path = root.appendingPathComponent("helper")
    let script = """
      #!/bin/sh
      exec /usr/bin/python3 -c 'import sys,json,os
      value=json.load(sys.stdin)
      assert len(sys.argv)==1
      assert "EAGLE_CONFIG" not in os.environ
      assert set(value)=={"action","binding","ownerToken","accessClientID","accessClientSecret"}
      assert value["action"]=="put" and value["binding"]["botId"]=="bot-a"
      assert len(value["ownerToken"])==40 and value["accessClientID"]=="access-fixture"
      print(json.dumps({"available":True}))'
      """
    try script.write(to: path, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
    let connection = try MachineConnection(
      address: "https://fixture.example.test", ownerToken: String(repeating: "k", count: 40),
      accessClientID: "access-fixture", accessClientSecret: "secret-fixture")
    let binding = BotRemoteCredentialBinding(
      namespace: String(repeating: "a", count: 64), botId: "bot-a",
      credentialRef: "fixture-reference", origin: connection.origin.absoluteString)
    let helper = BotCredentialHelper(executable: path)
    try await helper.put(binding, connection: connection)
    try "#!/bin/sh\nprintf '%s' '{\"available\":false}'\n".write(
      to: path, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
    await #expect(throws: (any Error).self) {
      try await helper.put(binding, connection: connection)
    }
    let other = BotRemoteCredentialBinding(
      namespace: binding.namespace, botId: binding.botId,
      credentialRef: binding.credentialRef, origin: "https://foreign.example.test")
    await #expect(throws: (any Error).self) { try await helper.put(other, connection: connection) }
  }
}
