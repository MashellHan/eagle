import Foundation

@main struct NativeExecutionFixture {
  struct Input: Decodable { let origin: String; let token: String; let mode: String }
  static func main() async throws {
    let value = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
    let connection = try MachineConnection(address: value.origin, ownerToken: value.token,
      accessClientID: "isolated-native-exec-access-id", accessClientSecret: "isolated-native-exec-access-secret")
    let client = MachineExecutionClient(connection: connection)
    let operation = MachineHerdrOperation(id: "native-operation", machineId: "native-mac", action: "probe", timeoutMs: 1000)
    switch value.mode {
    case "roundtrip":
      let record = try await client.run(operation)
      guard record.state == "succeeded", record.stdout == "actual machine result" else { fatalError("Wrong result") }
      guard try await client.get(machineID: "native-mac", operationID: operation.id) == record else { fatalError("Wrong history") }
      guard try await client.cancel(machineID: "native-mac", operationID: operation.id) else { fatalError("Missing acknowledgement") }
    case "authentication":
      do { _ = try await client.run(operation); fatalError("Accepted authentication failure") }
      catch MachineAccessError.authentication { }
    case "cancelled":
      let task = Task { try await client.run(operation) }
      try await Task.sleep(for: .milliseconds(100))
      task.cancel()
      do { _ = try await task.value; fatalError("Accepted cancelled connection") } catch { }
    default:
      do { _ = try await client.run(operation); fatalError("Accepted invalid execution response") } catch { }
    }
    print("native-execution-pass")
  }
}
