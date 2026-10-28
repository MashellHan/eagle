import Foundation
import Testing

@testable import EagleFeatures

private let executionOwner = "isolated-spm-execution-owner-token-at-least-32-characters"

private final class ExecutionServer {
  let process = Process()
  let port: Int
  init() throws {
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Fixtures/execution-server.mjs")
    process.arguments = ["node", fixture.path]
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    try process.run()
    let data = output.fileHandleForReading.availableData
    guard
      let value = Int(
        String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
      (1...65535).contains(value)
    else {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
      throw MachineExecutionError.invalid
    }
    port = value
  }
  func close() {
    if process.isRunning { process.terminate() }
    process.waitUntilExit()
  }
}

@Suite("Machine execution client") struct MachineExecutionTests {
  func client(_ port: Int = 17053) throws -> MachineExecutionClient {
    MachineExecutionClient(
      connection: try MachineConnection(
        address: "http://127.0.0.1:\(port)", ownerToken: executionOwner))
  }

  @Test(
    "instrumented client exchanges real WebSocket run/get/cancel and rejects HTTP and socket auth")
  func realWire() async throws {
    let fixture = try ExecutionServer()
    defer { fixture.close() }
    let client = try client(fixture.port)
    let result = try await client.run(
      .init(id: "wire-operation", machineId: "ready", action: "probe"))
    #expect(result.state == "succeeded" && result.stdout == "actual fixture result")
    #expect(try await client.get(machineID: "ready", operationID: "wire-operation") == result)
    #expect(try await client.cancel(machineID: "ready", operationID: "wire-operation"))
    for machine in ["authentication", "revoked"] {
      await #expect(throws: MachineAccessError.authentication) {
        try await client.get(machineID: machine, operationID: "wire-operation")
      }
    }
    await #expect(throws: MachineExecutionError.unknown) {
      try await client.get(machineID: "redirect", operationID: "wire-operation")
    }
    await #expect(throws: MachineExecutionError.invalid) {
      try await client.get(machineID: "binary", operationID: "wire-operation")
    }
    await #expect(throws: MachineExecutionError.offline) {
      try await client.get(machineID: "offline", operationID: "wire-operation")
    }
  }

  @Test(
    "deadline and caller cancellation close only the caller while heartbeat keeps long work alive")
  func lifetime() async throws {
    let fixture = try ExecutionServer()
    defer { fixture.close() }
    let client = try client(fixture.port)
    let pending = Task {
      try await client.run(
        .init(
          id: "wire-operation", machineId: "stall", action: "install"))
    }
    try await Task.sleep(for: .milliseconds(100))
    pending.cancel()
    await #expect(throws: MachineExecutionError.unknown) { try await pending.value }
    let started = Date()
    await #expect(throws: MachineExecutionError.unknown) {
      try await client.get(machineID: "stall", operationID: "wire-operation")
    }
    #expect(
      Date().timeIntervalSince(started) < 7,
      "5-second deadline must not wait for a peer close handshake")
    let reply = try await client.run(
      .init(id: "wire-operation", machineId: "heartbeat", action: "probe"))
    #expect(reply.stdout == "heartbeat verified")
    let stats = try await client.get(machineID: "stats", operationID: "wire-operation")
    let counts = try JSONDecoder().decode([String: Int].self, from: Data(stats.stdout.utf8))
    #expect(counts["runs"] == 2 && counts["cancels"] == 0 && counts["pings"] == 1)
  }

  @Test("invalid requests fail before opening a socket, including credentials in decoded fields")
  func admission() async throws {
    let client = try client(1)
    let invalid = [
      MachineHerdrOperation(id: "bad space", machineId: "m", action: "probe"),
      .init(id: "id", machineId: "../m", action: "probe"),
      .init(id: "id", machineId: "m", action: "other"),
      .init(id: "id", machineId: "m", action: "probe", timeoutMs: 0),
      .init(id: "id", machineId: "m", action: "probe", session: "session"),
      .init(id: "id", machineId: "m", action: "disable"),
      .init(id: "id", machineId: "m", action: "configure", session: "valid", enabled: true),
      .init(
        id: "id", machineId: "m", action: "create_session", session: executionOwner, enabled: true,
        expectedRevision: "rev"),
    ]
    for request in invalid {
      await #expect(throws: MachineExecutionError.invalid) { try await client.run(request) }
    }
    await #expect(throws: MachineExecutionError.invalid) {
      try await client.get(machineID: "bad machine", operationID: "valid")
    }
    await #expect(throws: MachineExecutionError.invalid) {
      try await client.cancel(machineID: "valid", operationID: executionOwner)
    }
  }

  @Test(
    "untrusted replies require exact identities, typed receipts and secret-free bounded results")
  func replies() throws {
    let client = try client()
    func decode(
      _ value: [String: Any], cancel: Bool = false
    ) throws -> MachineExecutionClient.Reply? {
      let data = try JSONSerialization.data(withJSONObject: value)
      return try client.decode(
        String(decoding: data, as: UTF8.self), requestID: "request", operationID: "operation",
        machineID: "mac", cancelling: cancel)
    }
    let validRecord: [String: Any] = [
      "id": "operation", "state": "succeeded", "stdout": "result", "stderr": "",
      "exitCode": NSNull(),
    ]
    #expect(try decode(["type": "pong"]) == nil)
    let status: [String: Any] = [
      "type": "status", "machineId": "mac", "online": false, "observedAt": NSNull(),
      "agentVersion": NSNull(), "capabilities": NSNull(),
    ]
    #expect(try decode(status) == nil)
    for (code, expected) in [
      "offline": MachineExecutionError.offline, "not_found": .notFound,
      "disabled": .disabled, "busy": .busy, "conflict": .conflict, "denied": .denied,
      "unavailable": .unknown, "unknown-error": .invalid,
    ] {
      #expect(throws: expected) {
        try decode([
          "type": "error", "requestId": "request", "operationId": "operation", "code": code,
        ])
      }
    }
    let invalidRecords: [[String: Any]] = [
      ["id": "other"], ["state": "new-state"], ["stdout": String(repeating: "a", count: 65537)],
      ["stdout": executionOwner], ["stderr": executionOwner], ["exitCode": 256],
      ["state": "running", "exitCode": 0], ["state": "succeeded", "exitCode": 1], ["extra": true],
    ]
    for changes in invalidRecords {
      #expect(throws: MachineExecutionError.invalid) {
        try decode([
          "type": "result", "requestId": "request",
          "operation": validRecord.merging(changes) { _, new in new },
        ])
      }
    }
    let malformed: [[String: Any]] = [
      ["type": "status", "machineId": "other"], ["type": "pong", "extra": true],
      ["type": "error", "requestId": "request", "operationId": "other", "code": "offline"],
      ["type": "result", "requestId": "other", "operation": validRecord],
      ["type": "result", "requestId": "request", "operation": validRecord, "extra": true],
      ["type": "result", "requestId": "request", "operation": [executionOwner: "credential-key"]],
      ["type": "result", "requestId": "request", "operation": ["nested": [executionOwner]]],
    ]
    for value in malformed {
      #expect(throws: MachineExecutionError.invalid) { try decode(value) }
    }
    for requested: Any in [0, "yes", NSNull()] {
      #expect(throws: MachineExecutionError.invalid) {
        try decode(
          [
            "type": "cancel-ack", "requestId": "request", "operationId": "operation",
            "requested": requested,
          ], cancel: true)
      }
    }
    #expect(throws: MachineExecutionError.invalid) {
      try client.decode(
        "not JSON", requestID: "request", operationID: "operation", machineID: "mac",
        cancelling: false)
    }
    #expect(throws: MachineExecutionError.invalid) {
      try client.decode(
        String(repeating: "x", count: 512 * 1024 + 1), requestID: "request",
        operationID: "operation", machineID: "mac", cancelling: false)
    }
  }
}
