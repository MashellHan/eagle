import BotsCore
import BotsFeatures
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Bot remote inspector", .serialized)
@MainActor struct BotRemoteWindowTests {
  private func machinePeer(status: Int) throws -> AppTokenHTTPServer {
    try AppTokenHTTPServer(expectedToken: String(repeating: "k", count: 40)) { path in
      if path == "/api/v1/machines" {
        return (
          200,
          #"{"machines":[{"id":"machine-b","name":"Build Mac","enabled":true},{"id":"machine-c","name":"Other Mac","enabled":true}],"canIssue":true}"#
        )
      }
      let id = path.contains("machine-c") ? "machine-c" : "machine-b"
      return (
        id == "machine-c" ? 200 : status,
        "{\"machineId\":\"\(id)\",\"online\":false,\"observedAt\":null,\"agentVersion\":null,\"capabilities\":null}"
      )
    }
  }

  private func grantModel(
    server: AppTokenHTTPServer
  ) throws -> (
    BotRemoteGrantModel, RemoteGrantPortFixture, RemoteGrantHelperFixture
  ) {
    let connection = try MachineConnection(
      address: "http://127.0.0.1:\(server.port)", ownerToken: String(repeating: "k", count: 40))
    let port = RemoteGrantPortFixture()
    let existing = BotRemoteTarget(
      alias: "existing", enabled: true, origin: connection.origin.absoluteString,
      machineId: "machine-b", credentialRef: "existing-ref", operations: [.readFile])
    port.current = BotRemoteConfiguration(
      namespace: port.current.namespace, revision: "r1", helperAvailable: true,
      cleanupPending: false, targets: [existing])
    let helper = RemoteGrantHelperFixture()
    let model = BotRemoteGrantModel(
      botID: "bot-a", botTitle: "Bot A", port: port, helper: helper,
      vault: RemoteGrantVaultFixture(connection), sharing: MemoryBotRemoteSharingStore(),
      coordinator: BotRemoteAccessCoordinator(),
      directory: { try await BotRemoteAccess.machineRows(connection: $0) })
    model.selectedMachineID = "machine-b"
    model.alias = "new-machine"
    model.permissions = [.readFile]
    return (model, port, helper)
  }

  @Test(arguments: [401, 403])
  func statusAuthenticationRejectsTheWholeGrantDirectoryButKeepsRevocation(status: Int) async throws
  {
    let server = try machinePeer(status: status)
    defer { server.close() }
    let (model, port, helper) = try grantModel(server: server)
    await model.load()
    #expect(server.requests.contains { $0.path == "/api/v1/execution/status?machine=machine-b" })
    #expect(server.requests.allSatisfy { $0.usesExpectedToken })
    #expect(model.machines.isEmpty, "a successful sibling must not create a partial authority list")
    #expect(!model.canGrant)
    #expect(model.message?.contains("部署凭据") == true)
    await model.grant()
    #expect(port.writes.isEmpty, "no disabled reservation after status authentication failure")
    #expect(helper.bindings.isEmpty, "no credential copy after status authentication failure")
    #expect(model.canRevoke)
    await model.revoke(alias: "existing")
    #expect(port.current.targets.isEmpty)
    #expect(port.writes.count == 1)
  }

  @Test(arguments: [200, 0])
  func offlineOrUnreachableStatusStillAllowsExplicitConfiguration(status: Int) async throws {
    let server = try machinePeer(status: status)
    defer { server.close() }
    let (model, port, helper) = try grantModel(server: server)
    await model.load()
    #expect(model.machines.map(\.id) == ["machine-b", "machine-c"])
    #expect(model.machines.allSatisfy { !$0.online })
    #expect(model.canGrant)
    await model.grant()
    #expect(helper.bindings.count == 1)
    #expect(port.writes.count == 2)
    #expect(port.current.targets.last?.enabled == true)
  }

  @Test func theSheetKeepsTheOpeningBotAndDepartureInvalidatesItsActions() async throws {
    let catalog = StubCatalog()
    catalog.bots = ["first", "second"].map {
      BotSummary(
        id: $0, title: $0, createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle)
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let outbox = OutboxStore(directory: root)
    let conversation = ConversationViewModel(
      botId: "", conversation: StubConversation(), outbox: outbox)
    let app = AppViewModel(catalog: catalog, conversation: conversation, outbox: outbox)
    let port = RemoteGrantPortFixture()
    var opened: [String] = []
    let window = BotsWorkspaceViewModel(
      makeApp: { _ in app }, gatewayProbe: { true },
      remoteGrantFactory: { bot in
        opened.append(bot.id)
        return BotRemoteGrantModel(
          botID: bot.id, botTitle: bot.title, port: port, helper: nil,
          vault: RemoteGrantVaultFixture(nil), sharing: MemoryBotRemoteSharingStore(),
          coordinator: BotRemoteAccessCoordinator(), directory: { _ in [] })
      })
    await window.start()
    window.select("first")
    await window.openRemoteGrant()
    let sheet = try #require(window.remoteGrant)
    #expect(sheet.botID == "first")
    #expect(sheet.configuration != nil)
    window.select("second")
    #expect(window.remoteGrant === sheet)
    #expect(sheet.botID == "first")
    window.dismissRemoteGrant()
    #expect(window.remoteGrant == nil)
    #expect(!sheet.canRevoke)
    await window.openRemoteGrant()
    #expect(opened == ["first", "second"])
    #expect(window.remoteGrant?.botID == "second")
    window.disconnect()
    #expect(window.remoteGrant == nil)
  }

  @Test func aMissingLocalCredentialIsReportedWithoutRawDiagnostics() async throws {
    let catalog = StubCatalog()
    catalog.bots = [
      BotSummary(
        id: "bot", title: "Bot", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle)
    ]
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let outbox = OutboxStore(directory: root)
    let app = AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(
        botId: "", conversation: StubConversation(), outbox: outbox), outbox: outbox)
    let window = BotsWorkspaceViewModel(
      makeApp: { _ in app }, gatewayProbe: { true },
      remoteGrantFactory: { _ in throw BotRemoteGrantError.needsLocal })
    await window.start()
    window.select("bot")
    await window.openRemoteGrant()
    #expect(window.remoteGrant == nil)
    #expect(window.remoteMessage?.contains("本机") == true)
    window.disconnect()
  }
}
