import Darwin
import Foundation

func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !value() {
    throw NSError(
      domain: "NativeMachineProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

@main
enum NativeMachineProbe {
  static func main() async {
    do { try await check() } catch {
      print("Native machine check failed: \(error.localizedDescription)")
      exit(1)
    }
  }

  static func check() async throws {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let fields = try JSONDecoder().decode([String: String].self, from: input)
    let mode = CommandLine.arguments[1]
    let token = fields["token"]!
    if mode == "addresses" {
      for address in [
        "http://example.com", "https://user:password@example.com", "https://example.com/path",
        "https://example.com?token=x", "https://example.com#fragment",
      ] {
        do {
          _ = try MachineConnection(address: address, ownerToken: token)
          throw NSError(domain: "ProbeAcceptedUnsafeAddress", code: 1)
        } catch MachineAccessError.invalidAddress {}
      }
      do {
        _ = try MachineConnection(address: "https://example.com", ownerToken: "bad")
        throw NSError(domain: "ProbeAcceptedInvalidCredential", code: 1)
      } catch MachineAccessError.invalidCredential {}
      print("address-boundaries-pass")
      return
    }
    let connection = try MachineConnection(
      address: fields["origin"]!, ownerToken: token,
      accessClientID: fields["accessID"], accessClientSecret: fields["accessSecret"]
    )
    let client = MachineHTTPClient(connection: connection)
    if mode == "names" {
      for name in [
        String(repeating: "a", count: 81), String(repeating: "b", count: 120),
        String(repeating: "😀", count: 60),
      ] {
        let machine = try await client.rename(id: "native-mac", name: name)
        try require(machine.name == name, "A valid contract name was refused")
      }
      for name in [String(repeating: "a", count: 121), String(repeating: "😀", count: 61)] {
        do {
          _ = try await client.rename(id: "native-mac", name: name)
          throw NSError(domain: "AcceptedOverlongName", code: 1)
        } catch MachineAccessError.invalidResponse {}
      }
      print("names-pass")
      return
    }
    if mode == "status-rejected" {
      do {
        _ = try await client.status(id: "native-mac")
        throw NSError(domain: "AcceptedInvalidObservation", code: 1)
      } catch MachineAccessError.invalidResponse {}
      print("status-rejection-pass")
      return
    }
    if mode == "status-offline" {
      let status = try await client.status(id: "native-mac")
      try require(!status.online && status.observedAt != nil, "Offline observation was discarded")
      print("offline-history-pass")
      return
    }
    if mode == "keychain" || mode == "model" || mode == "access-empty" {
      try await checkModel(connection: connection, mode: mode)
      return
    }
    if mode == "rejected" {
      do {
        _ = try await client.directory()
        throw NSError(domain: "ProbeAcceptedInvalidResponse", code: 1)
      } catch let error as MachineAccessError {
        try require(
          error == (fields["kind"] == "auth" ? .authentication : .invalidResponse),
          "Unexpected error classification")
      }
      print("rejection-pass")
      return
    }
    let directory = try await client.directory()
    try require(directory.canIssue, "Signing capability missing")
    try require(directory.machines.map(\.id) == ["native-mac"], "Directory identity mismatch")
    let status = try await client.status(id: "native-mac")
    try require(
      status.online && status.capabilities?.commands == false,
      "Online and command permission conflated")
    let renamed = try await client.rename(id: "native-mac", name: "书房 Mac")
    try require(renamed.name == "书房 Mac", "Rename was not acknowledged")
    let revoked = try await client.revoke(id: "native-mac")
    try require(!revoked.enabled, "Revoke was not acknowledged")
    print("http-machine-path-pass")
  }

  @MainActor
  static func checkModel(connection: MachineConnection, mode: String) async throws {
    let vault = KeychainMachineCredentials(service: "ai.hexly.eagle.test.\(UUID().uuidString)")
    defer { try? vault.remove() }
    try require(try vault.load() == nil, "Test vault must start empty")
    if mode == "keychain" {
      try vault.save(connection)
      try require(try vault.load() == connection, "Keychain round trip failed")
      let replacement = try MachineConnection(
        address: "https://new.example.test",
        ownerToken: "isolated-replacement-credential-at-least-32-characters")
      try vault.save(replacement)
      try require(try vault.load() == replacement, "Origin and credential did not change together")
      try vault.remove()
      try require(try vault.load() == nil, "Test credential remained after removal")
      print("keychain-pass")
      return
    }
    let model = MachineSettingsModel(vault: vault)
    try require(
      model.machines.isEmpty && model.phase == .unconfigured, "Unconfigured model invented machines"
    )
    model.address = connection.origin.absoluteString
    model.credential = connection.ownerToken
    model.useAccess = true
    if mode == "access-empty" {
      await model.testConnection()
      try require(
        model.message == MachineAccessError.invalidCredential.localizedDescription,
        "Empty required Access credentials reached the network")
      await model.saveAndConnect()
      try require(
        model.message == MachineAccessError.invalidCredential.localizedDescription,
        "Empty required Access credentials were saved")
      try require(try vault.load() == nil, "Invalid Access configuration was persisted")
      print("empty-access-refused")
      return
    }
    model.accessID = connection.accessClientID!
    model.accessSecret = connection.accessClientSecret!
    await model.saveAndConnect()
    try require(model.phase == .ready, "Connected directory not ready")
    try require(model.machines.count == 1 && model.machines[0].online, "Real row not online")
    try require(
      model.machines[0].statusText == "执行端在线 · 命令执行已禁用", "Permission and online state conflated")
    try require(
      model.credential.isEmpty && model.accessSecret.isEmpty && model.hasSavedCredential,
      "Secret draft not cleared")
    try require(try vault.load() == connection, "Connection was not stored atomically")
    model.renameText = "书房 Mac"
    await model.rename(id: "native-mac")
    try require(
      model.machines[0].machine.name == "书房 Mac", "Rename did not wait for acknowledgement")
    await model.revoke(id: "native-mac")
    try require(model.machines[0].statusText == "已停用接入", "Revoked machine remains executable")
    model.address = "https://different.example.test"
    await model.saveAndConnect()
    try require(
      model.message == MachineAccessError.invalidCredential.localizedDescription,
      "Saved secret was reused on another origin")
    try require(try vault.load() == connection, "Failed save changed the stored connection")
    print("model-machine-path-pass")
  }
}
