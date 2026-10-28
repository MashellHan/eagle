import Foundation
import Testing

@testable import EagleFeatures

private final class MachineHTTPStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    let lock = NSLock()
    var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
  }
  private static let storage = Storage()
  static var handler: (@Sendable (URLRequest) throws -> (Int, Data))? {
    get { storage.lock.withLock { storage.handler } }
    set { storage.lock.withLock { storage.handler = newValue } }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      guard let handler = Self.handler else { throw URLError(.notConnectedToInternet) }
      let (status, data) = try handler(request)
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private final class MachineRequestCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.withLock { value } }
  func record() { lock.withLock { value += 1 } }
}

private final class MachineDeferredHTTP: URLProtocol {
  private final class Storage: @unchecked Sendable {
    let lock = NSLock()
    var held: MachineDeferredHTTP?
    var enabled = true
  }
  private static let storage = Storage()
  static var isHolding: Bool { storage.lock.withLock { storage.held != nil } }
  static var holdRequests: Bool {
    get { storage.lock.withLock { storage.enabled } }
    set { storage.lock.withLock { storage.enabled = newValue } }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    if request.httpMethod == "POST" {
      respond(status: 401)
    } else if request.url!.host == "old.example.test" && Self.holdRequests {
      Self.storage.lock.withLock { Self.storage.held = self }
    } else {
      respond()
    }
  }
  override func stopLoading() {}
  private func respond(status: Int = 200) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"machines":[],"canIssue":true}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  static func release() {
    let request = storage.lock.withLock {
      defer { storage.held = nil }
      return storage.held
    }
    request?.respond()
  }
}

@MainActor
private final class MachineTestVault: MachineCredentialVault {
  var value: MachineConnection?
  var fails = false
  var readFails = false
  func load() throws -> MachineConnection? {
    if readFails { throw MachineAccessError.keychain(-25293) }
    return value
  }
  func save(_ connection: MachineConnection) throws {
    if fails { throw MachineAccessError.keychain(-25293) }
    value = connection
  }
  func remove() throws { value = nil }
}

@MainActor private final class DecliningConnectionWriter: MachineConnectionSaving {
  private enum Failure: Error { case cleanup }
  var calls = 0
  func requiresRevocation(origin: String) throws -> Bool { true }
  func save(
    _ connection: MachineConnection, replacing old: MachineConnection?,
    stillCurrent: @escaping @MainActor () -> Bool
  ) async throws {
    calls += 1
    throw Failure.cleanup
  }
}

private actor MachineTestAgent: LocalAgentAccess {
  var configuration: Data?
  var events: [String] = []
  var failingAction: String?
  var grants: [LocalMachineFileGrant] = []
  func fileGrants() async throws -> [LocalMachineFileGrant] { grants }
  func grantDirectory(path: String, name: String) async throws {
    events.append("grant")
    grants = [
      LocalMachineFileGrant(id: "fg_fixture", generation: "generation-one", name: name, root: path)
    ]
  }
  func revokeDirectory(id: String) async throws {
    events.append("revoke-grant")
    grants = []
  }
  func fail(_ action: String?) { failingAction = action }
  func identity() async throws -> LocalAgentIdentity {
    events.append("identity")
    guard let configuration else {
      return LocalAgentIdentity(machineId: "local-mac", configured: false)
    }
    let value = try JSONSerialization.jsonObject(with: configuration) as! [String: Any]
    let execution = value["execution"] as? [String: Any]
    return LocalAgentIdentity(
      machineId: "local-mac", configured: true,
      ownerOrigin: value["ownerOrigin"] as? String, url: value["url"] as? String,
      commands: execution?["commands"] as? Bool,
      workingDirectory: execution?["workingDirectory"] as? String)
  }
  func initialize(_ configuration: Data) async throws {
    events.append("init")
    self.configuration = configuration
  }
  func reconfigure(_ configuration: Data) async throws {
    events.append("reconfigure")
    let patch = try JSONSerialization.jsonObject(with: configuration) as! [String: Any]
    var existing = try JSONSerialization.jsonObject(with: self.configuration!) as! [String: Any]
    existing.merge(patch) { _, new in new }
    self.configuration = try JSONSerialization.data(withJSONObject: existing)
  }
  func control(_ action: String) async throws -> LocalAgentState {
    events.append(action)
    if failingAction == action { throw LocalAgentError.unavailable }
    return LocalAgentState(
      label: "ai.hexly.eagle.agent.0123456789abcdef01234567", installed: true,
      loaded: action == "start", disabled: action != "start", running: action == "start",
      pid: action == "start" ? 123 : nil, lastExit: nil)
  }
}

private actor MachineDelayedAgent: LocalAgentAccess {
  let heldAction: String
  var holdsLeft = 1
  var continuation: CheckedContinuation<Void, Never>?
  var waiting: Bool { continuation != nil }
  init(_ action: String) { heldAction = action }
  func release() {
    continuation?.resume()
    continuation = nil
  }
  func identity() async throws -> LocalAgentIdentity {
    LocalAgentIdentity(
      machineId: "local-mac", configured: heldAction == "start",
      ownerOrigin: heldAction == "start" ? "https://eagle.example.test" : nil)
  }
  func initialize(_ configuration: Data) async throws {}
  func control(_ action: String) async throws -> LocalAgentState {
    let held = action == heldAction && holdsLeft > 0
    if held {
      holdsLeft -= 1
      await withCheckedContinuation { continuation = $0 }
    }
    let running = action != "stop" && (action != "status" || held)
    return LocalAgentState(
      label: "ai.hexly.eagle.agent.0123456789abcdef01234567",
      installed: true, loaded: running, disabled: !running, running: running,
      pid: running ? 123 : nil, lastExit: nil)
  }
}

@Suite("Machine settings", .serialized)
@MainActor
struct MachineSettingsTests {
  private let token = "isolated-swift-owner-credential-at-least-32-characters"
  private func connection() throws -> MachineConnection {
    try MachineConnection(address: "https://eagle.example.test", ownerToken: token)
  }
  private func client(_ connection: MachineConnection) -> MachineHTTPClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MachineHTTPStub.self]
    return MachineHTTPClient(connection: connection, configuration: configuration)
  }
  private func model(_ vault: MachineTestVault = MachineTestVault()) -> MachineSettingsModel {
    let model = MachineSettingsModel(vault: vault, client: client)
    model.address = "https://eagle.example.test"
    model.credential = token
    return model
  }
  private func json(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value)
  }

  @Test func sharedConnectionCleanupFailurePreventsTheSettingsPageFromSaving() async throws {
    MachineHTTPStub.handler = { _ in (200, Data(#"{"machines":[],"canIssue":true}"#.utf8)) }
    let vault = MachineTestVault()
    vault.value = try connection()
    let writer = DecliningConnectionWriter()
    let model = MachineSettingsModel(vault: vault, connectionWriter: writer, client: client)
    await model.load()
    model.address = "https://new.example.test"
    model.credential = token
    await model.saveAndConnect()
    #expect(writer.calls == 1)
    #expect(vault.value == (try connection()))
    #expect(model.connectedAddress == "https://eagle.example.test")
    #expect(!model.busy)
    #expect(model.message?.contains("清理") == true)
  }

  @Test("local folder authorization waits for its CLI receipt and refuses a foreign deployment")
  func localFolderAuthorization() async throws {
    MachineHTTPStub.handler = { _ in (200, Data(#"{"machines":[],"canIssue":true}"#.utf8)) }
    let agent = MachineTestAgent()
    try await agent.initialize(
      json([
        "ownerOrigin": "https://eagle.example.test", "url": "https://ingest.example.test",
        "execution": ["commands": false, "workingDirectory": "."],
      ]))
    let model = MachineSettingsModel(vault: MachineTestVault(), agent: agent, client: client)
    model.address = "https://eagle.example.test"
    model.credential = token
    await model.saveAndConnect()
    await model.addFileGrant(path: "/tmp/Documents")
    #expect(model.localFileGrants.count == 1)
    #expect(model.localFileGrants.first?.name == "Documents")
    MachineHTTPStub.handler = { _ in throw URLError(.notConnectedToInternet) }
    await model.refresh()
    #expect(model.phase == .failed(.unavailable))
    await model.removeFileGrant(id: "fg_fixture")
    #expect(model.localFileGrants.isEmpty)
    #expect(model.fileGrantMessage == "授权已撤销" && !model.localBusy)
    MachineHTTPStub.handler = { _ in (200, Data(#"{"machines":[],"canIssue":true}"#.utf8)) }
    let before = await agent.events
    model.address = "https://foreign.example.test"
    model.credential = token
    await model.saveAndConnect()
    await model.addFileGrant(path: "/tmp/Foreign")
    #expect(
      await agent.events.filter { $0 == "grant" }.count == before.filter { $0 == "grant" }.count)
    #expect(model.fileGrantMessage == LocalAgentError.deploymentMismatch.localizedDescription)
    #expect(!model.localBusy)
  }

  @Test("connection values are validated on construction and decoding")
  func credentials() throws {
    let value = try connection()
    #expect(
      try JSONDecoder().decode(MachineConnection.self, from: JSONEncoder().encode(value)) == value)
    for address in [
      "http://example.test", "https://u:p@example.test", "https://example.test/path",
      "https://example.test?token=x", "https://example.test#x",
    ] {
      #expect(throws: MachineAccessError.invalidAddress) {
        try MachineConnection(address: address, ownerToken: token)
      }
    }
    #expect(throws: MachineAccessError.invalidCredential) {
      try MachineConnection(address: value.origin.absoluteString, ownerToken: "bad")
    }
    #expect(throws: MachineAccessError.invalidCredential) {
      try MachineConnection(
        address: value.origin.absoluteString, ownerToken: token, accessClientID: "half")
    }
    #expect(
      try MachineConnection(address: "https://EAGLE.example.test:443/", ownerToken: token).origin
        == value.origin)
    #expect(
      try MachineConnection(address: "http://127.0.0.1:4000", ownerToken: token).origin.port == 4000
    )
  }

  @Test("a real, isolated Keychain item replaces origin and credential together")
  func keychain() throws {
    let store = KeychainMachineCredentials(service: "ai.hexly.eagle.test.\(UUID().uuidString)")
    defer { try? store.remove() }
    #expect(try store.load() == nil)
    try store.save(connection())
    #expect(try store.load() == connection())
    let replacement = try MachineConnection(
      address: "https://another.example.test", ownerToken: String(repeating: "q", count: 40))
    try store.save(replacement)
    #expect(try store.load() == replacement)
    try store.remove()
    #expect(try store.load() == nil)
  }

  @Test("empty, authentication failure, unreachable status and offline are different states")
  func states() async throws {
    let empty = try json(["machines": [], "canIssue": false])
    MachineHTTPStub.handler = { _ in (200, empty) }
    defer { MachineHTTPStub.handler = nil }
    let page = model()
    #expect(page.phase == .unconfigured && page.machines.isEmpty)
    await page.saveAndConnect()
    #expect(page.phase == .ready && page.machines.isEmpty && !page.canIssue)
    let directory = try json([
      "machines": [["id": "mac-a", "name": "Mac A", "enabled": true]], "canIssue": true,
    ])
    MachineHTTPStub.handler = { request in
      request.url!.path.hasSuffix("status") ? (503, Data()) : (200, directory)
    }
    await page.refresh()
    #expect(page.machines[0].statusText == "状态未知 · 无法读取执行状态")
    MachineHTTPStub.handler = { _ in (401, Data()) }
    await page.refresh()
    #expect(page.phase == .failed(.authentication))
    #expect(!page.canManage && page.machines[0].observation == .unknown)
    let machine = ManagedMachine(id: "mac-a", name: "Mac A", enabled: true)
    let absent = MachineExecutionStatus(
      machineId: machine.id, online: false, observedAt: nil, agentVersion: nil, capabilities: nil)
    #expect(
      MachineRow(machine: machine, observation: .observed(absent)).statusText == "已注册 · 执行端尚未连接")
    let offline = MachineExecutionStatus(
      machineId: machine.id, online: false, observedAt: "2026-10-28T05:00:00.000Z",
      agentVersion: "1.1.0-alpha.0", capabilities: .init(commands: true))
    #expect(MachineRow(machine: machine, observation: .observed(offline)).statusText == "执行端离线")
  }

  @Test("Access intent and failed Keychain saves cannot silently become a ready connection")
  func failedSave() async throws {
    let vault = MachineTestVault()
    let page = model(vault)
    page.useAccess = true
    await page.testConnection()
    #expect(page.message == MachineAccessError.invalidCredential.localizedDescription)
    page.useAccess = false
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { _ in (200, empty) }
    defer { MachineHTTPStub.handler = nil }
    vault.fails = true
    await page.saveAndConnect()
    #expect(page.phase == .unconfigured && vault.value == nil && !page.hasSavedCredential)
    #expect(page.message == MachineAccessError.keychain(-25293).localizedDescription)
    vault.fails = false
    await page.saveAndConnect()
    #expect(page.hasSavedCredential && page.credential.isEmpty)
    page.address = "https://another.example.test"
    await page.saveAndConnect()
    #expect(page.message == MachineAccessError.invalidCredential.localizedDescription)
    #expect(vault.value?.origin.absoluteString == "https://eagle.example.test")
  }

  @Test("saved credentials are restored without repopulating secret fields")
  func restore() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { _ in (200, empty) }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, client: client)
    await page.load()
    #expect(page.phase == .ready && page.hasSavedCredential)
    #expect(page.credential.isEmpty && page.accessSecret.isEmpty)
    await page.load()
    await page.testConnection()
    #expect(page.message == "连接验证通过；保存后接入此部署")
  }

  @Test("background refresh respects an open machine action and preserves its failure")
  func refreshDuringAction() async throws {
    let directory = try json([
      "machines": [["id": "mac-a", "name": "Mac A", "enabled": true]], "canIssue": true,
    ])
    MachineHTTPStub.handler = { request in
      request.url!.path.hasSuffix("status") ? (503, Data()) : (200, directory)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = model()
    await page.saveAndConnect()
    page.renameTarget = "mac-a"
    MachineHTTPStub.handler = { _ in (401, Data()) }
    await page.refresh()
    #expect(page.phase == .ready, "An open rename dialog must defer background polling")
    page.renameTarget = nil
    MachineHTTPStub.handler = { request in
      request.httpMethod == "POST" || request.url!.path.hasSuffix("status")
        ? (503, Data()) : (200, directory)
    }
    page.renameText = "Changed"
    await page.rename(id: "mac-a")
    #expect(page.operationErrors["mac-a"] != nil)
    let failure = page.operationErrors["mac-a"]
    await page.refresh()
    #expect(page.operationErrors["mac-a"] == failure)
  }

  @Test("a failed Keychain read can be retried on the same page")
  func retryKeychain() async throws {
    let vault = MachineTestVault()
    vault.readFails = true
    vault.value = try connection()
    let page = MachineSettingsModel(vault: vault, client: client)
    await page.load()
    #expect(page.credentialReadFailed)
    vault.readFails = false
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { _ in (200, empty) }
    defer { MachineHTTPStub.handler = nil }
    await page.load()
    #expect(page.phase == .ready && !page.credentialReadFailed)
  }

  @Test("a departed page cannot overwrite a newer page's saved deployment")
  func departedSave() async throws {
    let vault = MachineTestVault()
    func page(_ host: String) -> MachineSettingsModel {
      let page = MachineSettingsModel(
        vault: vault,
        client: { connection in
          let configuration = URLSessionConfiguration.ephemeral
          configuration.protocolClasses = [MachineDeferredHTTP.self]
          return MachineHTTPClient(connection: connection, configuration: configuration)
        })
      page.address = "https://\(host).example.test"
      page.credential = token
      return page
    }
    let old = page("old")
    let oldSave = Task { await old.saveAndConnect() }
    defer { MachineDeferredHTTP.release() }
    for _ in 0..<200 {
      if MachineDeferredHTTP.isHolding { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    try #require(MachineDeferredHTTP.isHolding)
    old.invalidate()
    let current = page("new")
    await current.saveAndConnect()
    #expect(vault.value?.origin.absoluteString == "https://new.example.test")
    MachineDeferredHTTP.release()
    await oldSave.value
    #expect(current.connectedAddress == "https://new.example.test")
    #expect(vault.value?.origin.absoluteString == current.connectedAddress)
    #expect(!old.hasSavedCredential && !old.busy)
  }

  @Test(
    "registration and rotation return a distinct machine credential, never an owner or Access secret"
  )
  func issueMachineCredential() async throws {
    let owner = try connection()
    let machineToken = "isolated-machine-credential-at-least-32-characters"
    let reply = try json([
      "machine": ["id": "new-mac", "name": "New Mac", "enabled": true], "token": machineToken,
    ])
    MachineHTTPStub.handler = { request in
      #expect(request.httpMethod == "POST")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(owner.ownerToken)")
      return (201, reply)
    }
    defer { MachineHTTPStub.handler = nil }
    let api = client(owner)
    #expect(try await api.create(id: "new-mac", name: " New Mac ").token == machineToken)
    #expect(try await api.rotate(id: "new-mac").machine.id == "new-mac")
    let wrongSecret = try json([
      "machine": ["id": "new-mac", "name": "New Mac", "enabled": true], "token": owner.ownerToken,
    ])
    MachineHTTPStub.handler = { _ in (201, wrongSecret) }
    await #expect(throws: MachineAccessError.invalidResponse) {
      try await api.create(id: "new-mac", name: "New Mac")
    }
    await #expect(throws: MachineAccessError.invalidResponse) {
      try await api.rotate(id: "../wrong")
    }
  }

  @Test(
    "local setup registers once, sends only the issued machine credential and controls an independent service"
  )
  func localSetup() async throws {
    let vault = MachineTestVault()
    vault.value = try MachineConnection(
      address: "https://dashboard.example.test", ownerToken: token,
      accessClientID: "isolated-access-id", accessClientSecret: "isolated-access-secret")
    let agent = MachineTestAgent()
    let directory = try json(["machines": [], "canIssue": true])
    let issued = try json([
      "machine": ["id": "local-mac", "name": "Local Mac", "enabled": true],
      "token": "isolated-local-machine-token-at-least-32-characters",
    ])
    MachineHTTPStub.handler = { request in
      #expect(request.url?.host == "dashboard.example.test")
      return request.httpMethod == "POST" ? (201, issued) : (200, directory)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    page.agentAddress = "https://ingest.example.test"
    page.localMachineName = "Local Mac"
    await page.enableLocal()
    let data = try #require(await agent.configuration)
    let text = String(decoding: data, as: UTF8.self)
    #expect(!text.contains(token) && !text.contains("isolated-access"))
    let config = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(config["url"] as? String == "https://ingest.example.test")
    #expect(config["machineId"] as? String == "local-mac")
    #expect((config["execution"] as? [String: Any])?["commands"] as? Bool == false)
    #expect(await agent.events == ["identity", "init", "install", "start"])
    #expect(page.localState?.running == true && !page.localBusy)
    await page.enableLocal()
    #expect(await agent.events.filter { $0 == "init" }.count == 1)
    let offlinePage = MachineSettingsModel(agent: agent)
    await offlinePage.controlLocal("stop")
    #expect(offlinePage.localState?.disabled == true)
  }

  @Test("an explicitly selected Node path is validated before it is persisted")
  func chooseNode() async {
    let agent = MachineTestAgent()
    var saved: String?
    let page = MachineSettingsModel(
      nodeSelection: { $0 == "/private/selected/node" ? agent : nil }, saveNode: { saved = $0 })
    await page.selectNode("/invalid/node")
    #expect(saved == nil && !page.localAgentAvailable)
    await page.selectNode("/private/selected/node")
    #expect(saved == "/private/selected/node" && page.savedNodePath == saved)
    #expect(page.localAgentAvailable && page.localState?.installed == true)
    #expect(await agent.events == ["status"])
  }

  @Test("an invalid local working directory is rejected before registration or configuration")
  func invalidLocalDirectory() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let agent = MachineTestAgent()
    let empty = try json(["machines": [], "canIssue": true])
    let issued = try json([
      "machine": ["id": "local-mac", "name": "Mac", "enabled": true],
      "token": "isolated-machine-credential-at-least-32-characters",
    ])
    MachineHTTPStub.handler = { request in
      #expect(request.httpMethod != "POST", "Invalid local settings must not register in the cloud")
      return request.httpMethod == "POST" ? (201, issued) : (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    page.agentAddress = "https://ingest.example.test"
    page.commandDirectory = "."
    page.localCommands = true
    await page.enableLocal()
    #expect(await agent.configuration == nil)
    #expect(await agent.events.isEmpty)
    #expect(page.localState == nil && !page.localBusy)
  }

  @Test("machine mutations cannot invalidate an in-flight local service control")
  func localBusyAndMachineMutation() async throws {
    let agent = MachineDelayedAgent("start")
    let vault = MachineTestVault()
    vault.value = try connection()
    let directory = try json([
      "machines": [["id": "mac-a", "name": "A", "enabled": true]], "canIssue": true,
    ])
    let renamed = try json(["machine": ["id": "mac-a", "name": "Changed", "enabled": true]])
    MachineHTTPStub.handler = { request in
      request.httpMethod == "POST" ? (200, renamed) : (200, directory)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    let start = Task { await page.controlLocal("start") }
    for _ in 0..<200 {
      if await agent.waiting { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(await agent.waiting)
    #expect(!page.canManage)
    page.renameText = "Changed"
    await page.rename(id: "mac-a")
    await agent.release()
    await start.value
    #expect(!page.localBusy && page.localState?.running == true)
    #expect(page.machines[0].machine.name == "A")
  }

  @Test("an old service status cannot overwrite a subsequently confirmed stop")
  func staleLocalStatus() async throws {
    let agent = MachineDelayedAgent("status")
    let page = MachineSettingsModel(agent: agent)
    let refresh = Task { await page.refreshLocal() }
    for _ in 0..<200 {
      if await agent.waiting { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(await agent.waiting)
    await page.controlLocal("stop")
    await agent.release()
    await refresh.value
    #expect(page.localState?.running == false && page.localState?.disabled == true)
  }

  @Test("concurrent local status reads keep the newer observation")
  func orderedLocalStatus() async throws {
    let agent = MachineDelayedAgent("status")
    let page = MachineSettingsModel(agent: agent)
    let older = Task { await page.refreshLocal() }
    for _ in 0..<200 {
      if await agent.waiting { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(await agent.waiting)
    await page.refreshLocal()
    await agent.release()
    await older.value
    #expect(page.localState?.running == false)
  }

  @Test("a directory request started before setup rejection cannot restore authenticated UI state")
  func authenticationInvalidatesOldReads() async throws {
    let vault = MachineTestVault()
    vault.value = try MachineConnection(address: "https://old.example.test", ownerToken: token)
    let page = MachineSettingsModel(
      vault: vault, agent: MachineTestAgent(),
      client: { connection in
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MachineDeferredHTTP.self]
        return MachineHTTPClient(connection: connection, configuration: configuration)
      })
    MachineDeferredHTTP.holdRequests = false
    defer {
      MachineDeferredHTTP.release()
      MachineDeferredHTTP.holdRequests = true
    }
    await page.load()
    MachineDeferredHTTP.holdRequests = true
    let older = Task { await page.refresh() }
    for _ in 0..<200 {
      if MachineDeferredHTTP.isHolding { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(MachineDeferredHTTP.isHolding)
    page.agentAddress = "https://ingest.example.test"
    await page.enableLocal()
    #expect(page.phase == .failed(.authentication))
    MachineDeferredHTTP.release()
    await older.value
    #expect(page.phase == .failed(.authentication) && !page.canManage && !page.localBusy)
  }

  @Test("switching the owner deployment clears the old ingestion destination")
  func switchDeployment() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { _ in (200, empty) }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, client: client)
    await page.load()
    page.agentAddress = "https://old-ingest.example.test"
    page.address = "https://new-owner.example.test"
    page.credential = String(repeating: "q", count: 40)
    await page.saveAndConnect()
    #expect(page.connectedAddress == "https://new-owner.example.test" && page.agentAddress.isEmpty)
  }

  @Test("a quota conflict does not offer credential rotation for an absent machine")
  func quotaConflict() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { request in
      request.httpMethod == "POST" ? (409, Data()) : (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: MachineTestAgent(), client: client)
    await page.load()
    page.agentAddress = "https://ingest.example.test"
    await page.enableLocal()
    #expect(
      !page.canRecoverLocal
        && page.localMessage == MachineAccessError.server(409).localizedDescription)
  }

  @Test(
    "setup authentication failure invalidates cloud management just like directory authentication")
  func setupAuthentication() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { request in
      request.httpMethod == "POST" ? (401, Data()) : (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: MachineTestAgent(), client: client)
    await page.load()
    page.agentAddress = "https://ingest.example.test"
    await page.enableLocal()
    #expect(page.phase == .failed(.authentication) && !page.canManage)
    #expect(page.localMessage == MachineAccessError.authentication.localizedDescription)
  }

  @Test("a configured Agent cannot be silently started for another owner deployment")
  func configuredDeploymentBinding() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let agent = MachineTestAgent()
    try await agent.initialize(
      json([
        "machineId": "local-mac", "url": "https://old-ingest.example.test",
        "ownerOrigin": "https://old-owner.example.test",
        "token": "isolated-previous-machine-token-at-least-32-characters",
        "execution": [
          "commands": false, "workingDirectory": FileManager.default.temporaryDirectory.path,
        ],
      ]))
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { _ in (200, empty) }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    page.agentAddress = "https://new-ingest.example.test"
    await page.enableLocal()
    #expect(await agent.events == ["init", "identity"])
    #expect(
      page.localState == nil
        && page.localMessage == LocalAgentError.deploymentMismatch.localizedDescription)
  }

  @Test(
    "explicit repair stops, updates and starts the same identity without registration or credential exposure"
  )
  func configuredRepair() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let agent = MachineTestAgent()
    try await agent.initialize(
      json([
        "machineId": "local-mac", "url": "https://ingest.example.test",
        "ownerOrigin": "https://eagle.example.test",
        "token": "isolated-existing-machine-token-at-least-32-characters",
        "execution": ["commands": false, "workingDirectory": "."],
      ]))
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { request in
      #expect(request.httpMethod != "POST")
      return (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    await page.readLocalConfiguration()
    #expect(page.agentAddress == "https://ingest.example.test" && page.commandDirectory == ".")
    page.agentAddress = "https://ingest.example.test"
    page.commandDirectory = FileManager.default.temporaryDirectory.path
    await page.enableLocal(repair: true)
    #expect(
      await agent.events == [
        "init", "identity", "identity", "status", "stop", "reconfigure", "install", "start",
      ])
    let config = try #require(await agent.configuration)
    let stored = try #require(JSONSerialization.jsonObject(with: config) as? [String: Any])
    #expect(stored["token"] as? String == "isolated-existing-machine-token-at-least-32-characters")
    #expect(
      (stored["execution"] as? [String: Any])?["workingDirectory"] as? String
        == page.commandDirectory)
  }

  @Test("direct start checks owner binding while foreign and unbound configurations can still stop")
  func directStartBinding() async throws {
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { _ in (200, empty) }
    defer { MachineHTTPStub.handler = nil }
    for owner in [nil, "https://foreign.example.test", "https://eagle.example.test"] as [String?] {
      let vault = MachineTestVault()
      vault.value = try connection()
      let agent = MachineTestAgent()
      var config: [String: Any] = [
        "machineId": "local-mac", "url": "https://ingest.example.test",
        "token": "isolated-existing-machine-token-at-least-32-characters",
        "execution": ["commands": false, "workingDirectory": "."],
      ]
      config["ownerOrigin"] = owner
      try await agent.initialize(json(config))
      let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
      await page.load()
      await page.controlLocal("start")
      #expect(await agent.events.contains("start") == (owner == "https://eagle.example.test"))
      #expect(!page.localBusy)
      await page.controlLocal("stop")
      #expect(await agent.events.contains("stop"))
    }
  }

  @Test("installed unbound manual configuration can be edited but requires explicit rotation")
  func installedUnboundEntry() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let agent = MachineTestAgent()
    try await agent.initialize(
      json([
        "machineId": "local-mac", "url": "https://ingest.example.test",
        "token": "isolated-existing-machine-token-at-least-32-characters",
        "execution": ["commands": false, "workingDirectory": "."],
      ]))
    let empty = try json(["machines": [], "canIssue": true])
    let issued = try json([
      "machine": ["id": "local-mac", "name": "Manual Mac", "enabled": true],
      "token": "isolated-rotated-machine-token-at-least-32-characters",
    ])
    MachineHTTPStub.handler = { request in
      if request.httpMethod == "POST" {
        #expect(request.url?.path.hasSuffix("/rotate") == true)
        return (200, issued)
      }
      return (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    await page.refreshLocal()
    await page.readLocalConfiguration()
    #expect(page.localState?.installed == true && page.editingLocal && page.canRepairLocal)
    await page.enableLocal(repair: true)
    let beforeRotation = await agent.events
    #expect(!beforeRotation.contains("start") && !beforeRotation.contains("reconfigure"))
    // The user explicitly confirms the existing ingestion origin before rotating.
    page.agentAddress = "https://ingest.example.test"
    await page.enableLocal(rotate: true, repair: true)
    let afterRotation = await agent.events
    #expect(afterRotation.contains("start") && afterRotation.contains("reconfigure"))
    let config = try #require(await agent.configuration)
    let stored = try #require(JSONSerialization.jsonObject(with: config) as? [String: Any])
    #expect(stored["ownerOrigin"] as? String == "https://eagle.example.test")
    #expect(stored["token"] as? String == "isolated-rotated-machine-token-at-least-32-characters")
  }

  @Test("file-only setup does not depend on the unused command working directory")
  func disabledCommandDirectory() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let agent = MachineTestAgent()
    let empty = try json(["machines": [], "canIssue": true])
    let issued = try json([
      "machine": ["id": "local-mac", "name": "Mac", "enabled": true],
      "token": "isolated-file-only-machine-token-at-least-32-characters",
    ])
    MachineHTTPStub.handler = { request in
      request.httpMethod == "POST" ? (201, issued) : (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    page.agentAddress = "https://ingest.example.test"
    page.localCommands = false
    page.commandDirectory = "."
    await page.enableLocal()
    #expect(page.localState?.running == true)
    #expect(await agent.configuration != nil)
  }

  @Test("online capability evidence requires a matching machine and a real UTC timestamp")
  func onlineEvidence() async throws {
    let api = client(try connection())
    defer { MachineHTTPStub.handler = nil }
    for observed in ["2026-10-28T05:00:00Z", "2026-10-28T05:00:00.123Z"] {
      let reply = try json([
        "machineId": "mac-a", "online": true, "observedAt": observed,
        "agentVersion": "1.1.0-alpha.0", "capabilities": ["commands": true],
      ])
      MachineHTTPStub.handler = { request in
        #expect(request.url?.query == "machine=mac-a")
        return (200, reply)
      }
      let status = try await api.status(id: "mac-a")
      let row = MachineRow(
        machine: .init(id: "mac-a", name: "Mac A", enabled: true), observation: .observed(status))
      #expect(row.online && row.statusText == "执行端在线 · 已允许命令执行")
    }
    for observed in ["2026-02-30T05:00:00Z", "2026-10-28T25:00:00Z", "not-a-time"] {
      let reply = try json([
        "machineId": "mac-a", "online": true, "observedAt": observed,
        "agentVersion": "1.1.0-alpha.0", "capabilities": ["commands": false],
      ])
      MachineHTTPStub.handler = { _ in (200, reply) }
      await #expect(throws: MachineAccessError.invalidResponse) {
        try await api.status(id: "mac-a")
      }
    }
    let noCommands = MachineExecutionStatus(
      machineId: "mac-a", online: true, observedAt: "2026-10-28T05:00:00Z",
      agentVersion: "1.1.0-alpha.0", capabilities: .init(commands: false))
    #expect(
      MachineRow(
        machine: .init(id: "mac-a", name: "A", enabled: true),
        observation: .observed(noCommands)
      ).statusText == "执行端在线 · 命令执行已禁用")
    let disabled = MachineRow(
      machine: .init(id: "mac-a", name: "A", enabled: false),
      observation: .observed(noCommands))
    #expect(!disabled.online && disabled.statusText == "已停用接入")
  }

  @Test("a credential-shaped machine identifier is refused before any HTTP request")
  func credentialIdentifiers() async throws {
    let owner = try MachineConnection(
      address: "https://eagle.example.test", ownerToken: token,
      accessClientID: "isolated-access-client", accessClientSecret: "isolated-access-secret")
    let api = client(owner)
    let requests = MachineRequestCounter()
    MachineHTTPStub.handler = { _ in
      requests.record()
      return (200, Data("{}".utf8))
    }
    defer { MachineHTTPStub.handler = nil }
    for id in [owner.ownerToken, owner.accessClientID!, owner.accessClientSecret!] {
      await #expect(throws: MachineAccessError.invalidResponse) { try await api.status(id: id) }
      await #expect(throws: MachineAccessError.invalidResponse) {
        try await api.create(id: id, name: "Fixture Mac")
      }
      await #expect(throws: MachineAccessError.invalidResponse) { try await api.rotate(id: id) }
      await #expect(throws: MachineAccessError.invalidResponse) {
        try await api.rename(id: id, name: "Fixture Mac")
      }
      await #expect(throws: MachineAccessError.invalidResponse) { try await api.revoke(id: id) }
    }
    #expect(requests.count == 0, "known credentials must not enter machine request URLs or bodies")
  }

  @Test("file grants and ready Herdr require complete, secret-free capability evidence")
  func providerEvidence() async throws {
    let api = client(try connection())
    let grant: [String: Any] = [
      "id": "fg_documents", "generation": "generation-one", "name": "Documents", "available": true,
    ]
    let herdr: [String: Any] = [
      "state": "ready", "installed": true, "enabled": true, "version": "1.0.0",
      "session": "fixture", "revision": "revision-one",
      "sessions": [["name": "fixture", "running": true]],
      "checks": ["cli": true, "server": true, "session": true, "tools": true],
      "observedAt": "2026-10-28T05:00:00Z",
    ]
    func response(grants: [[String: Any]], plugin: [String: Any]) throws -> Data {
      try json([
        "machineId": "mac-a", "online": true, "observedAt": "2026-10-28T05:00:00Z",
        "agentVersion": "1.1.0-alpha.2",
        "capabilities": [
          "commands": false, "files": ["state": "ready", "grants": grants], "herdr": plugin,
        ],
      ])
    }
    let ready = try response(grants: [grant], plugin: herdr)
    MachineHTTPStub.handler = { _ in (200, ready) }
    defer { MachineHTTPStub.handler = nil }
    let status = try await api.status(id: "mac-a")
    #expect(status.capabilities?.commands == false)
    #expect(status.capabilities?.files?.grants.first?.name == "Documents")
    #expect(status.capabilities?.herdr?.label == "可用")
    #expect(status.capabilities?.herdr?.sessions.first?.id == "fixture")

    var secretGrant = grant
    secretGrant["name"] = token
    for grants in [[grant, grant], [secretGrant]] {
      let reply = try response(grants: grants, plugin: herdr)
      MachineHTTPStub.handler = { _ in (200, reply) }
      await #expect(throws: MachineAccessError.invalidResponse) {
        try await api.status(id: "mac-a")
      }
    }
    let incomplete: [[String: Any]] = [
      ["checks": ["cli": true, "server": true, "session": true, "tools": false]],
      ["sessions": [["name": "fixture", "running": false]]],
      ["enabled": false], ["version": token], ["observedAt": "2026-02-30T05:00:00Z"],
    ]
    for patch in incomplete {
      let reply = try response(
        grants: [grant], plugin: herdr.merging(patch) { _, updated in updated })
      MachineHTTPStub.handler = { _ in (200, reply) }
      await #expect(throws: MachineAccessError.invalidResponse) {
        try await api.status(id: "mac-a")
      }
    }
  }

  @Test("rename and revoke update only after matching server receipts")
  func machineMutations() async throws {
    let directory = try json([
      "machines": [["id": "mac-a", "name": "Mac A", "enabled": true]], "canIssue": true,
    ])
    let renamed = try json(["machine": ["id": "mac-a", "name": "Changed", "enabled": true]])
    let revoked = try json(["machine": ["id": "mac-a", "name": "Changed", "enabled": false]])
    MachineHTTPStub.handler = { request in
      if request.url!.path.hasSuffix("rename") { return (200, renamed) }
      if request.url!.path.hasSuffix("revoke") { return (200, revoked) }
      return request.url!.path.hasSuffix("status") ? (503, Data()) : (200, directory)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = model()
    await page.saveAndConnect()
    page.renameTarget = "mac-a"
    page.renameText = " Changed "
    await page.rename(id: "mac-a")
    #expect(page.machines[0].machine.name == "Changed" && page.renameTarget == nil)
    page.revokeTarget = "mac-a"
    await page.revoke(id: "mac-a")
    #expect(!page.machines[0].machine.enabled && page.revokeTarget == nil)
    #expect(page.machines[0].observation == .unknown && !page.busy)
    let wrong = try json(["machine": ["id": "mac-b", "name": "Changed", "enabled": false]])
    MachineHTTPStub.handler = { _ in (200, wrong) }
    let api = client(try connection())
    await #expect(throws: MachineAccessError.invalidResponse) {
      try await api.rename(id: "mac-a", name: "Changed")
    }
    await #expect(throws: MachineAccessError.invalidResponse) { try await api.revoke(id: "mac-a") }
    MachineHTTPStub.handler = { _ in (503, Data()) }
    await page.revoke(id: "mac-a")
    #expect(page.operationErrors["mac-a"] == MachineAccessError.server(503).localizedDescription)
  }

  @Test("saved Access is preserved as a pair and a partial replacement makes no request")
  func savedAccess() async throws {
    let vault = MachineTestVault()
    vault.value = try MachineConnection(
      address: "https://eagle.example.test", ownerToken: token,
      accessClientID: "old-access-id", accessClientSecret: "old-access-secret")
    let empty = try json(["machines": [], "canIssue": true])
    MachineHTTPStub.handler = { request in
      #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == "old-access-id")
      #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "old-access-secret")
      return (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, client: client)
    await page.load()
    await page.saveAndConnect()
    #expect(vault.value?.accessClientSecret == "old-access-secret")
    page.accessID = "replacement-id"
    await page.testConnection()
    #expect(page.message == MachineAccessError.invalidCredential.localizedDescription)
    page.accessSecret = "replacement-secret"
    MachineHTTPStub.handler = { request in
      #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == "replacement-id")
      #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "replacement-secret")
      return (200, empty)
    }
    await page.saveAndConnect()
    #expect(vault.value?.accessClientID == "replacement-id" && page.accessID.isEmpty)
  }

  @Test("per-machine authentication failure invalidates observed capabilities")
  func observationAuthentication() async throws {
    let directory = try json([
      "machines": [["id": "mac-a", "name": "A", "enabled": true]], "canIssue": true,
    ])
    MachineHTTPStub.handler = { request in
      request.url!.path.hasSuffix("status") ? (403, Data()) : (200, directory)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = model()
    await page.saveAndConnect()
    #expect(page.phase == .failed(.authentication) && !page.canManage)
    #expect(page.machines[0].observation == .unknown && !page.machines[0].online)
    page.invalidate()
    await page.refresh()
    page.activate()
    MachineHTTPStub.handler = nil
    await page.refresh()
    #expect(page.phase == .failed(.unavailable))
  }

  @Test(
    "an interrupted registration recovers only through explicit rotation of its reserved identity")
  func registrationRecovery() async throws {
    let vault = MachineTestVault()
    vault.value = try connection()
    let agent = MachineTestAgent()
    let empty = try json([
      "machines": [["id": "local-mac", "name": "Local Mac", "enabled": true]], "canIssue": true,
    ])
    let issued = try json([
      "machine": ["id": "local-mac", "name": "Local Mac", "enabled": true],
      "token": "isolated-rotated-machine-credential-at-least-32-characters",
    ])
    MachineHTTPStub.handler = { request in
      if request.url!.path.hasSuffix("rotate") { return (201, issued) }
      return request.httpMethod == "POST" ? (409, Data()) : (200, empty)
    }
    defer { MachineHTTPStub.handler = nil }
    let page = MachineSettingsModel(vault: vault, agent: agent, client: client)
    await page.load()
    page.agentAddress = "https://ingest.example.test"
    await page.enableLocal()
    #expect(page.canRecoverLocal && page.localMachineID == "local-mac")
    #expect(await agent.configuration == nil)
    await page.enableLocal(rotate: true)
    #expect(!page.canRecoverLocal && page.localState?.running == true)
    #expect(await agent.events.filter { $0 == "init" }.count == 1)
    await agent.fail("status")
    await page.refreshLocal()
    #expect(
      page.localState == nil
        && page.localMessage == LocalAgentError.unavailable.localizedDescription)
    await agent.fail("stop")
    await page.controlLocal("stop")
    #expect(
      !page.localBusy && page.localMessage == LocalAgentError.unavailable.localizedDescription)
    var saved: String?
    await agent.fail("status")
    let selecting = MachineSettingsModel(nodeSelection: { _ in agent }, saveNode: { saved = $0 })
    await selecting.selectNode("/selected/node")
    #expect(saved == nil && !selecting.localAgentAvailable)
  }
}
