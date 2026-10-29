import CryptoKit
import Foundation
import Security
import Testing

@testable import EagleDevices

private final class MemoryVault: DeviceIdentityVault, @unchecked Sendable {
  var values: [String: Data] = [:]
  var inserts = 0
  var loseRace: Data?
  func read(account: String) throws -> Data? { values[account] }
  func insert(_ data: Data, account: String) throws -> Bool {
    inserts += 1
    if let loseRace {
      values[account] = loseRace
      return false
    }
    values[account] = data
    return true
  }
}

@Suite("Device Keychain identity")
struct DeviceIdentityTests {
  @Test("an installation reuses its persisted identity, including a concurrent creation winner")
  func persistentIdentity() throws {
    let vault = MemoryVault()
    let first = try DeviceIdentity.loadOrCreate(profile: "test", vault: vault)
    let second = try DeviceIdentity.loadOrCreate(profile: "test", vault: vault)
    #expect(first.deviceId == second.deviceId)
    #expect(first.publicKey == second.publicKey)
    #expect(vault.inserts == 1)
    #expect(first.deviceId == first.deviceId.lowercased())
    let racer = MemoryVault()
    racer.loseRace = try vault.read(account: "test")
    #expect(
      try DeviceIdentity.loadOrCreate(profile: "test", vault: racer).publicKey == first.publicKey)
    vault.values["corrupt"] = Data("invalid".utf8)
    #expect(throws: (any Error).self) {
      try DeviceIdentity.loadOrCreate(profile: "corrupt", vault: vault)
    }
    #expect(vault.inserts == 1)
  }

  @Test("the real Keychain retains an isolated installation identity")
  func realKeychain() throws {
    let account = "device-test-" + UUID().uuidString
    defer {
      SecItemDelete(
        [
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: "ai.hexly.eagle.device-identity.v1",
          kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
    let first = try DeviceIdentity.loadOrCreate(profile: account)
    let next = try DeviceIdentity.loadOrCreate(profile: account)
    #expect(first.deviceId == next.deviceId)
    #expect(first.publicKey == next.publicKey)
  }

  @Test("registration signs exact bound seven-field bytes, never arbitrary payloads")
  func registration() throws {
    let identity = try DeviceIdentity.loadOrCreate(profile: "test", vault: MemoryVault())
    let now: Int64 = 1_800_000_000_000
    let fields = [
      "eagle-device-register-v1", "https://device.example", identity.deviceId,
      identity.publicKey, UUID().uuidString.lowercased(), Data(repeating: 5, count: 32).base64URL,
      String(now + 60000),
    ]
    let payload = fields.joined(separator: "\n")
    let signed = try identity.signRegistration(payload, serviceOrigin: fields[1], now: now)
    let publicBytes = try #require(Data(base64URL: identity.publicKey))
    let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicBytes.dropFirst(12))
    #expect(
      publicKey.isValidSignature(try #require(Data(base64URL: signed)), for: Data(payload.utf8)))
    for index in 0..<fields.count {
      var wrong = fields
      wrong[index] = "invalid"
      #expect(throws: DeviceIdentityError.self) {
        try identity.signRegistration(
          wrong.joined(separator: "\n"), serviceOrigin: fields[1], now: now)
      }
    }
    #expect(throws: DeviceIdentityError.self) {
      try identity.signRegistration(payload + "\n", serviceOrigin: fields[1], now: now)
    }
    #expect(throws: DeviceIdentityError.self) {
      try identity.signRegistration(payload, serviceOrigin: fields[1], now: now + 60000)
    }
  }

  @Test("approval verifies full operation, identity, policy and time before signing")
  func approval() throws {
    let identity = try DeviceIdentity.loadOrCreate(profile: "test", vault: MemoryVault())
    let now: Int64 = 1_800_000_000_000
    let request = try makeRequest(
      identity: identity,
      operation: .object([
        "kind": .string("file.write"), "path": .string("/tmp/output"), "content": .string("hello"),
      ]), now: now)
    let approval = try identity.approve(request, now: now)
    let publicKey = try Curve25519.Signing.PublicKey(
      rawRepresentation: (try #require(Data(base64URL: identity.publicKey))).dropFirst(12))
    #expect(
      publicKey.isValidSignature(
        try #require(Data(base64URL: approval.signature)), for: Data(request.signingPayload.utf8)))
    #expect(throws: DeviceIdentityError.self) {
      try identity.approve(request, now: request.expiresAt)
    }
    let other = try DeviceIdentity.loadOrCreate(profile: "other", vault: MemoryVault())
    #expect(throws: DeviceIdentityError.self) { try other.approve(request, now: now) }
    #expect(throws: DeviceIdentityError.self) {
      try identity.signRegistration(
        request.signingPayload, serviceOrigin: "https://device.example", now: now)
    }
  }

  @Test(
    "typed approval rejects incomplete operations and unknown fields instead of signing a digest alone"
  )
  func rejectsIncompleteOperation() throws {
    let identity = try DeviceIdentity.loadOrCreate(profile: "test", vault: MemoryVault())
    let now: Int64 = 1_800_000_000_000
    for operation: DeviceJSON in [
      .object(["kind": .string("command")]),
      .object(["kind": .string("file.write"), "path": .string("/tmp/output")]),
      .object(["kind": .string("command"), "command": .string("pwd"), "approved": .bool(true)]),
      .object(["kind": .string("native"), "tool": .string("unsupported"), "args": .object([:])]),
    ] {
      let request = try makeRequest(identity: identity, operation: operation, now: now)
      #expect(throws: DeviceIdentityError.self) { try identity.approve(request, now: now) }
    }
  }

  @Test("canonical JSON matches JS key order, Unicode and number forms")
  func canonical() throws {
    let value: DeviceJSON = .object([
      "z": .string("书/房\n"), "a": .array([.number(1), .bool(true), .null]),
    ])
    #expect(try value.canonical() == "{\"a\":[1,true,null],\"z\":\"书/房\\n\"}")
    for (number, expected) in [
      (1e-7, "1e-7"), (1e-6, "0.000001"), (1e20, "100000000000000000000"), (1e21, "1e+21"),
      (-0.0, "0"),
    ] {
      #expect(try DeviceJSON.number(number).canonical() == expected)
    }
    #expect(throws: DeviceIdentityError.self) { try DeviceJSON.number(.infinity).canonical() }
    #expect(Data(base64URL: "bad=") == nil)
    #expect(try DeviceJSON.encoded(value).decoded(DeviceJSON.self) == value)
  }

  @Test("uppercase approval UUIDs verify with the actual service contract")
  func crossLanguageApproval() throws {
    let identity = try DeviceIdentity.loadOrCreate(profile: "test", vault: MemoryVault())
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let original = try makeRequest(
      identity: identity,
      operation: .object([
        "kind": .string("command"), "command": .string("pwd"),
      ]), now: now)
    guard case .object(var fields) = try DeviceJSON.encoded(original) else { return }
    fields["requestId"] = .string(original.requestId.uppercased())
    fields["operationId"] = .string(original.operationId.uppercased())
    fields["targetDeviceId"] = .string(original.targetDeviceId.uppercased())
    let request = try DeviceJSON.object(fields).decoded(DeviceApprovalRequest.self)
    let approval = try identity.approve(request, now: now)
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../").standardizedFileURL
    let module = root.appendingPathComponent("packages/contracts/src/devices.ts").absoluteString
    let script = """
      import {readFileSync} from 'node:fs';
      import {DeviceApproval,OperationRequest,verifyApproval} from '\(module)';
      const x=JSON.parse(readFileSync(0,'utf8'));
      const approval=DeviceApproval.parse(x.approval);
      const request=OperationRequest.parse({...x.request,action:'run'});
      console.log(await verifyApproval(approval,request,{deviceId:approval.sourceDeviceId,publicKey:x.publicKey},{mode:'always-ask',version:approval.policyVersion}));
      """
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", "--input-type=module", "-e", script]
    let input = Pipe()
    let output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = Pipe()
    try process.run()
    var wire = fields
    wire.removeValue(forKey: "policyVersion")
    wire.removeValue(forKey: "expiresAt")
    wire.removeValue(forKey: "sourceDeviceId")
    let payload = try DeviceJSON.encoded(approval)
    try input.fileHandleForWriting.write(
      contentsOf: JSONEncoder().encode(
        DeviceJSON.object([
          "approval": payload, "request": .object(wire), "publicKey": .string(identity.publicKey),
        ])))
    try input.fileHandleForWriting.close()
    let answer = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    #expect(process.terminationStatus == 0)
    #expect(
      String(data: answer, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        == "true")
    #expect(request.operationId == original.operationId)
    #expect(request.targetDeviceId == original.targetDeviceId)
  }

  @Test("the helper and independent Bot adapter share canonical wire vectors")
  func sharedVector() throws {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../fixtures/bots-protocol/device-access-v1/canonical.json")
      .standardizedFileURL
    let vector = try JSONDecoder().decode(DeviceJSON.self, from: Data(contentsOf: path))
    let operation = try #require(vector["operation"])
    #expect(try operation.canonical() == vector["canonical"]?.string)
    #expect(try DeviceApprovalRequest.digest(operation) == vector["digest"]?.string)
  }

  private func makeRequest(
    identity: DeviceIdentity, operation: DeviceJSON, now: Int64
  ) throws -> DeviceApprovalRequest {
    try DeviceJSON.object([
      "requestId": .string(UUID().uuidString.lowercased()),
      "operationId": .string(UUID().uuidString.lowercased()),
      "sourceDeviceId": .string(identity.deviceId),
      "targetDeviceId": .string(UUID().uuidString.lowercased()),
      "operation": operation, "digest": .string(try DeviceApprovalRequest.digest(operation)),
      "policyVersion": .number(2), "expiresAt": .number(Double(now + 60000)),
    ]).decoded(DeviceApprovalRequest.self)
  }
}
