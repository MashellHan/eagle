import Foundation
import Testing

@testable import EagleFeatures

private actor HerdrExecutionFixture: MachineExecutionAccess {
  var runs: [MachineHerdrOperation] = []
  var queries: [String] = []
  var cancellations: [String] = []
  var failure: MachineAccessError?
  var queryFailure: MachineExecutionError?
  var runState = "succeeded"
  var sessionName = "work"
  func failQueries(_ value: MachineExecutionError?) { queryFailure = value }
  func setRunState(_ value: String) { runState = value }
  func setSession(_ value: String) { sessionName = value }
  var waiting: CheckedContinuation<Void, Never>?
  var hold = false
  func setFailure(_ value: MachineAccessError?) { failure = value }
  func setHold() { hold = true }
  func release() {
    waiting?.resume()
    waiting = nil
  }
  var isWaiting: Bool { waiting != nil }
  let status =
    #"{"state":"ready","installed":true,"version":"0.9.5","enabled":true,"session":"work","revision":"revision-two","sessions":[{"name":"work","running":true}],"checks":{"cli":true,"server":true,"session":true,"tools":true},"observedAt":"2026-10-28T08:00:00.000Z"}"#
  func run(_ operation: MachineHerdrOperation) async throws -> MachineOperationRecord {
    runs.append(operation)
    if hold { await withCheckedContinuation { waiting = $0 } }
    if let failure { throw failure }
    return MachineOperationRecord(
      id: operation.id, state: runState,
      stdout: runState == "succeeded"
        ? status.replacingOccurrences(of: "work", with: sessionName) : "",
      stderr: "", exitCode: nil)
  }
  func get(machineID: String, operationID: String) async throws -> MachineOperationRecord {
    queries.append(operationID)
    if let queryFailure { throw queryFailure }
    return MachineOperationRecord(
      id: operationID, state: "succeeded", stdout: status, stderr: "", exitCode: nil)
  }
  func cancel(machineID: String, operationID: String) async throws -> Bool {
    cancellations.append(operationID)
    return true
  }
}

private actor PendingHerdrFixture: MachineExecutionAccess {
  let lostReply: Bool
  var first: String?
  var queries: [String] = []
  var runs = 0
  var state = "running"
  init(lostReply: Bool) { self.lostReply = lostReply }
  func finish(_ value: String) { state = value }
  func run(_ operation: MachineHerdrOperation) async throws -> MachineOperationRecord {
    runs += 1
    guard first == nil else { throw MachineExecutionError.busy }
    first = operation.id
    if lostReply { throw MachineExecutionError.unknown }
    return .init(id: operation.id, state: state, stdout: "", stderr: "", exitCode: nil)
  }
  func get(machineID: String, operationID: String) async throws -> MachineOperationRecord {
    queries.append(operationID)
    guard operationID == first else { throw MachineExecutionError.notFound }
    return .init(id: operationID, state: state, stdout: "", stderr: "", exitCode: nil)
  }
  func cancel(machineID: String, operationID: String) async throws -> Bool { false }
}

@Suite("Machine Herdr model") @MainActor struct MachineHerdrTests {
  let token = "isolated-herdr-native-owner-at-least-32-characters"
  func connection() throws -> MachineConnection {
    try MachineConnection(address: "https://fixture.example.test", ownerToken: token)
  }
  private func make(
    _ store: any MachineOperationStore, _ client: HerdrExecutionFixture,
    authenticationFailed: @escaping () -> Void = {}
  ) throws -> MachineHerdrModel {
    MachineHerdrModel(
      machine: ManagedMachine(id: "herdr-mac", name: "Fixture Mac", enabled: true),
      connection: try connection(), store: store, client: client,
      authenticationFailed: authenticationFailed)
  }
  @Test(
    "reopening queries the saved operation without replaying it or calling cached evidence current")
  func reopen() async throws {
    let store = MemoryMachineOperationStore()
    let client = HerdrExecutionFixture()
    let first = try make(store, client)
    await first.perform("probe")
    #expect(first.record?.state == "succeeded" && first.status?.state == "ready")
    let reference = try #require(first.reference)
    #expect(
      try store.load(origin: connection().origin.absoluteString, machine: "herdr-mac") == reference)
    first.invalidate()
    let next = try make(store, client)
    await next.load()
    #expect(await client.runs.count == 1)
    #expect(await client.queries == [reference.id])
    #expect(next.historical && next.status == nil && next.record?.id == reference.id)
    let encoded = try JSONEncoder().encode(reference)
    #expect(!String(decoding: encoded, as: UTF8.self).contains(token))
  }
  @Test(
    "leaving the page retains its uncertain operation and ignores late replies without remote cancel"
  )
  func departed() async throws {
    let store = MemoryMachineOperationStore()
    let client = HerdrExecutionFixture()
    await client.setHold()
    let model = try make(store, client)
    let task = Task { await model.perform("probe") }
    for _ in 0..<100 {
      if await client.isWaiting { break }
      await Task.yield()
    }
    #expect(await client.isWaiting)
    model.invalidate()
    await client.release()
    await task.value
    #expect(model.record == nil && !model.busy)
    #expect(await client.cancellations.isEmpty)
    #expect(try store.load(origin: connection().origin.absoluteString, machine: "herdr-mac") != nil)
  }
  @Test(
    "authentication failure disables the parent context and explicit cancel keeps the original ID")
  func authentication() async throws {
    let store = MemoryMachineOperationStore()
    let client = HerdrExecutionFixture()
    await client.setFailure(.authentication)
    var rejected = false
    let model = try make(store, client, authenticationFailed: { rejected = true })
    await model.perform("probe")
    #expect(rejected && model.record == nil && !model.busy)
    let id = try #require(model.reference?.id)
    await model.cancel()
    #expect(await client.cancellations == [id])
  }
  @Test(
    "running and lost replies retain the admitted ID across a new probe and reopening",
    arguments: [false, true])
  func pendingBookmark(lostReply: Bool) async throws {
    let store = MemoryMachineOperationStore()
    let client = PendingHerdrFixture(lostReply: lostReply)
    let machine = ManagedMachine(id: "herdr-mac", name: "Fixture Mac", enabled: true)
    let model = MachineHerdrModel(
      machine: machine, connection: try connection(), store: store, client: client)
    await model.perform("install")
    let original = try #require(model.reference)
    await model.perform("probe")
    #expect(model.reference == original)
    #expect(await client.runs == 1)
    model.invalidate()
    let reopened = MachineHerdrModel(
      machine: machine, connection: try connection(), store: store, client: client)
    await reopened.load()
    #expect(await client.queries == [original.id])
    #expect(reopened.reference == original)
  }
  @Test("explicit unknown recovery preserves its ID after a new operation and store reopening")
  func recoverUnknown() async throws {
    let suite = "eagle-herdr-bookmark-test-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = DefaultsMachineOperationStore(defaults: defaults)
    let client = PendingHerdrFixture(lostReply: false)
    let machine = ManagedMachine(id: "herdr-mac", name: "Fixture Mac", enabled: true)
    let model = MachineHerdrModel(
      machine: machine, connection: try connection(), store: store, client: client)
    await model.perform("install")
    let original = try #require(model.reference)
    model.continueAfterInspection()
    #expect(model.reference == original && !model.canStart)
    await client.finish("unknown")
    await model.query()
    #expect(model.canContinueAfterInspection)
    model.continueAfterInspection()
    #expect(model.reference == nil && model.canStart)
    #expect(model.savedReferences == [original])
    let healthy = HerdrExecutionFixture()
    let reopened = MachineHerdrModel(
      machine: machine, connection: try connection(),
      store: DefaultsMachineOperationStore(defaults: defaults), client: healthy)
    await reopened.load()
    #expect(await healthy.runs.count == 1)
    #expect(reopened.savedReferences == [original])
    await reopened.querySaved(original)
    #expect(await healthy.queries == [original.id])
    #expect(reopened.historical)
  }
  @Test(
    "another window's pending bookmark survives historical query and stale terminal restoration",
    arguments: [false, true])
  func sharedWindow(restoring: Bool) async throws {
    let store = MemoryMachineOperationStore()
    let saved = MachineOperationReference(id: "saved-unknown", action: "install", createdAt: Date())
    let origin = try connection().origin.absoluteString
    try store.save(saved, origin: origin, machine: "herdr-mac")
    try store.archive(saved, origin: origin, machine: "herdr-mac")
    let client = HerdrExecutionFixture()
    let first = try make(store, client)
    await first.load()
    let second = try make(store, client)
    await second.load()
    await client.setRunState("running")
    await second.perform("install")
    let pending = try #require(second.reference)
    if restoring {
      await client.failQueries(.unknown)
      await first.load()
      await first.perform("probe")
    } else {
      await first.querySaved(saved)
    }
    #expect(try store.load(origin: origin, machine: "herdr-mac") == pending)
    #expect(await client.runs.count == 2)
    #expect(first.unresolved)
  }
  @Test(
    "reopening the same panel drops stale ready evidence while retaining the original operation")
  func reusedPanel() async throws {
    let client = HerdrExecutionFixture()
    let model = try make(MemoryMachineOperationStore(), client)
    await model.perform("probe")
    #expect(model.status?.state == "ready")
    let original = model.reference
    model.invalidate()
    await client.failQueries(.offline)
    model.activate()
    await model.load()
    #expect(model.status == nil && model.reference == original)
    #expect(await client.runs.count == 1)
  }
  @Test("created session becomes the selection used by the next explicit configure")
  func createdSelection() async throws {
    let client = HerdrExecutionFixture()
    let model = try make(MemoryMachineOperationStore(), client)
    await model.perform("probe")
    #expect(model.selectedSession == "work")
    model.createNew = true
    model.newSession = "new-session"
    await client.setSession("new-session")
    await model.perform("create_session")
    #expect(model.status?.session == "new-session")
    #expect(model.selectedSession == "new-session" && !model.createNew)
    await model.perform("configure")
    #expect(await client.runs.last?.session == "new-session")
  }
}
