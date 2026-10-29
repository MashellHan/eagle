import Foundation
import Testing

@testable import EagleDevices

private final class HostVault: DeviceIdentityVault, @unchecked Sendable {
  var data: Data?
  func read(account: String) throws -> Data? { data }
  func insert(_ value: Data, account: String) throws -> Bool {
    data = value
    return true
  }
}

@Suite("Private device host") @MainActor
struct DeviceServiceHostTests {
  private func host() throws -> DeviceServiceHost {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(
      "../../../../"
    ).standardizedFileURL
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", "-p", "process.execPath"]
    let output = Pipe()
    process.standardOutput = output
    try process.run()
    let path = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    process.waitUntilExit()
    let directory = URL(fileURLWithPath: "/tmp/eagle-host-" + UUID().uuidString.prefix(12))
    let configuration = try JSONDecoder().decode(
      DeviceHostConfiguration.self,
      from: Data(
        #"{"version":1,"profile":"isolated-test","baseUrl":"http://127.0.0.1:1","machServiceName":"ai.hexly.eagle.devices.test","launchAgentPlist":"ai.hexly.eagle.devices.test.plist"}"#
          .utf8))
    return DeviceServiceHost(
      identity: try .loadOrCreate(profile: "test", vault: HostVault()),
      configuration: configuration,
      node: URL(fileURLWithPath: path),
      entry: root.appendingPathComponent("packages/agent/dist/agent/device-service.js"),
      stateDirectory: directory)
  }
  private func ready(_ host: DeviceServiceHost) async throws {
    try host.start()
    for _ in 0..<200 {
      if host.localReady { return }
      if host.failure != nil { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw DevicePortError(host.failure ?? "host_not_ready")
  }
  private func clean(_ host: DeviceServiceHost) async throws {
    await host.stop()
    try FileManager.default.removeItem(at: host.stateDirectory)
  }

  @Test("helper configures offline tools automatically and keeps management off the Bot socket")
  func offline() async throws {
    let host = try host()
    try await ready(host)
    do {
      #expect(host.cloudStatus == "offline")
      let port = DeviceLocalPort(path: host.socketPath)
      let status = try await port.call("status")
      #expect(status["localReady"]?.bool == true)
      #expect(status["policy"]?["mode"]?.string == "all-approve")
      let output = host.stateDirectory.appendingPathComponent("proof.txt")
      let operation: DeviceJSON = .object([
        "kind": .string("file.write"), "path": .string(output.path), "content": .string("真实本机"),
      ])
      let request: DeviceJSON = .object([
        "requestId": .string(UUID().uuidString.lowercased()),
        "operationId": .string(UUID().uuidString.lowercased()),
        "targetDeviceId": .string(host.identity.deviceId), "action": .string("run"),
        "operation": operation, "digest": .string(try DeviceApprovalRequest.digest(operation)),
      ])
      let initial = try await port.call("execute", params: request)
      #expect(["running", "completed"].contains(initial["status"]?.string ?? ""))
      for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: output.path) { break }
        try await Task.sleep(for: .milliseconds(10))
      }
      #expect(try String(contentsOf: output, encoding: .utf8) == "真实本机")
      await #expect(throws: DevicePortError.self) {
        try await port.call("policy.set", params: .object(["mode": .string("paused")]))
      }
      let policy = try await host.call("policy.set", params: .object(["mode": .string("paused")]))
      #expect(policy["mode"]?.string == "paused")
      #expect(try await port.call("status")["policy"]?["mode"]?.string == "paused")
    } catch {
      try await clean(host)
      throw error
    }
    try await clean(host)
  }

  @Test("only an attached App confirmation signs a complete typed service approval")
  func confirmation() async throws {
    let host = try host()
    try await ready(host)
    do {
      let policy = try await host.call(
        "policy.set", params: .object(["mode": .string("always-ask")]))
      let operation: DeviceJSON = .object([
        "kind": .string("command"), "command": .string("printf approved"),
      ])
      let request: DeviceJSON = .object([
        "requestId": .string(UUID().uuidString.lowercased()),
        "operationId": .string(UUID().uuidString.lowercased()),
        "targetDeviceId": .string(host.identity.deviceId), "action": .string("run"),
        "operation": operation, "digest": .string(try DeviceApprovalRequest.digest(operation)),
      ])
      let params: DeviceJSON = .object([
        "request": request, "policyVersion": policy["version"] ?? .null,
        "expiresAt": .number(Double(Int64(Date().timeIntervalSince1970 * 1000) + 30000)),
      ])
      let port = DeviceLocalPort(path: host.socketPath)
      await #expect(throws: DevicePortError.self) {
        try await port.call("approval.request", params: params)
      }
      var seen: DeviceApprovalRequest?
      host.approver = { request in
        seen = request
        return true
      }
      var approved: DeviceJSON?
      do { approved = try await port.call("approval.request", params: params) } catch {}
      #expect(seen?.operation == operation)
      #expect(approved?["approval"]?["signature"]?.string != nil)
      host.approver = { _ in false }
      await #expect(throws: DevicePortError.self) {
        try await port.call("approval.request", params: params)
      }
    } catch {
      try await clean(host)
      throw error
    }
    try await clean(host)
  }

  @Test(
    "the real kernel supplies a stable UUID and build configuration rejects secret-bearing URLs")
  func configuration() throws {
    let first = try #require(DeviceHostConfiguration.bootSessionID())
    #expect(UUID(uuidString: first) != nil)
    #expect(DeviceHostConfiguration.bootSessionID() == first)
    let config = try JSONDecoder().decode(
      DeviceHostConfiguration.self,
      from: Data(
        #"{"version":1,"profile":"test","baseUrl":"https://user:secret@example.com/?token=private","machServiceName":"ai.hexly.eagle.devices.test","launchAgentPlist":"ai.hexly.eagle.devices.test.plist"}"#
          .utf8))
    #expect(throws: DeviceHostError.self) { try config.validate() }
  }
}
