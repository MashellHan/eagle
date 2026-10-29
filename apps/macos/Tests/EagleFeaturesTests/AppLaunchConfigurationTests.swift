import BotsCore
import BotsFeatures
import Foundation
import Network
import Testing

@testable import EagleFeatures

@Suite("App verification composition", .serialized)
@MainActor struct AppLaunchConfigurationTests {
  private func withRoot(
    _ body: (URL, [String: String]) async throws -> Void
  ) async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eagle-app-verification-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let environment = [
      "EAGLE_APP_VERIFICATION_ROOT": root.path,
      "BOTS_PORT": "52117", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    ]
    try await body(root, environment)
  }

  @Test func ordinaryLaunchRetainsExistingSettingsAndAutomaticConnection() async throws {
    let launch = try AppLaunchConfiguration(environment: ["BOTS_ROOT": "/fixture/ordinary-bots"])
    #expect(launch.verificationRoot == nil)
    #expect(launch.defaults === UserDefaults.standard)
    #expect(launch.botsSettings.rootPath == "/fixture/ordinary-bots")
    #expect(launch.credentialsService == "ai.hexly.eagle.machine-access")
    #expect(launch.loadsDaemonEnvironment)
    var started = 0
    await launch.runAutomaticConnection { started += 1 }
    #expect(started == 1)
  }

  @Test func verificationOverridesDataPathsAndDoesNotInheritCredentials() async throws {
    try await withRoot { _, environment in
      var input = environment
      input["BOTS_ROOT"] = "/fixture/daily-bots"
      input["EAGLE_CONFIG"] = "/fixture/daily-agent.json"
      input["XDG_CONFIG_HOME"] = "/fixture/daily-providers"
      input["MAGPIE_API_KEY"] = "fixture-must-not-be-inherited"
      input["BOTS_NODE"] = "/fixture/node"
      let launch = try AppLaunchConfiguration(environment: input)
      let root = try #require(launch.verificationRoot)
      let domain = try #require(launch.preferencesDomain)
      try #require(launch.defaults !== UserDefaults.standard)
      defer { launch.defaults.removePersistentDomain(forName: domain) }
      #expect(launch.environment["BOTS_ROOT"] == root.appendingPathComponent("bots").path)
      #expect(
        launch.environment["EAGLE_CONFIG"] == root.appendingPathComponent("agent/agent.json").path)
      #expect(launch.environment["XDG_CONFIG_HOME"] == root.appendingPathComponent("config").path)
      #expect(launch.environment["MAGPIE_API_KEY"] == nil)
      #expect(launch.environment["BOTS_NODE"] == "/fixture/node")
      #expect(launch.botsSettings.port == "52117")
      #expect(launch.outboxDirectory == root.appendingPathComponent("outbox"))
      #expect(launch.refusalFallback == root.appendingPathComponent("refusals"))
      let pending = OutboxEntry(
        botId: "verification-bot", requestId: "verification-request", text: "private fixture")
      try JSONEncoder().encode([pending]).write(
        to: root.appendingPathComponent("outbox/outbox.json"))
      #expect(try launch.makeOutbox().all().map(\.requestId) == ["verification-request"])
      #expect(!launch.loadsDaemonEnvironment)
      var started = 0
      await launch.runAutomaticConnection { started += 1 }
      #expect(started == 0)
    }
  }

  @Test func preferencesReopenWithinOneProfileAndStaySeparateFromAnother() async throws {
    try await withRoot { _, firstEnvironment in
      try await withRoot { _, secondEnvironment in
        let first = try AppLaunchConfiguration(environment: firstEnvironment)
        let second = try AppLaunchConfiguration(environment: secondEnvironment)
        let firstDomain = try #require(first.preferencesDomain)
        let secondDomain = try #require(second.preferencesDomain)
        try #require(first.defaults !== UserDefaults.standard)
        try #require(second.defaults !== UserDefaults.standard)
        defer {
          first.defaults.removePersistentDomain(forName: firstDomain)
          second.defaults.removePersistentDomain(forName: secondDomain)
        }
        #expect(first.credentialsService != "ai.hexly.eagle.machine-access")
        #expect(first.credentialsService != second.credentialsService)
        first.defaults.set("/fixture/selected-node", forKey: "eagle.machine-agent.nodePath")
        first.defaults.set("dark", forKey: "eagle.appearance")
        first.defaults.synchronize()
        let reopened = try AppLaunchConfiguration(environment: firstEnvironment)
        #expect(reopened.credentialsService == first.credentialsService)
        #expect(reopened.defaults.string(forKey: "eagle.appearance") == "dark")
        #expect(second.defaults.string(forKey: "eagle.appearance") == nil)
        let machine = MachineSettingsModel.live(configuration: reopened)
        #expect(machine.savedNodePath == "/fixture/selected-node")
      }
    }
  }

  @Test func verificationConnectionRequiresItsExplicitSwitch() async throws {
    try await withRoot { _, environment in
      var input = environment
      input["EAGLE_APP_VERIFICATION_CONNECT_BOTS"] = "1"
      let launch = try AppLaunchConfiguration(environment: input)
      let domain = try #require(launch.preferencesDomain)
      try #require(launch.defaults !== UserDefaults.standard)
      defer { launch.defaults.removePersistentDomain(forName: domain) }
      var started = 0
      await launch.runAutomaticConnection { started += 1 }
      #expect(started == 1)
    }
  }

  @Test func selectedEnvironmentSuppliesEveryActualHTTPClient() async throws {
    try await withRoot { root, _ in
      let token = "selected-profile-token-01234567890123456789"
      let server = try AppTokenHTTPServer(expectedToken: token)
      defer { server.close() }
      try "file-token-from-another-source-0123456789".write(
        to: root.appendingPathComponent("token"), atomically: true, encoding: .utf8)
      let settings = BotsSettings(environment: [
        "BOTS_ROOT": root.path, "BOTS_PORT": String(server.port), "BOTS_TOKEN": token,
      ])
      try await exerciseHTTPClients(settings: settings, root: root)
      #expect(
        server.requests.map(\.path) == [
          "/v1/settings", "/v1/bots", "/v1/bots", "/v1/settings",
          "/v1/bots/fixture-bot/remote-tools",
        ])
      #expect(server.requests.allSatisfy { $0.usesExpectedToken })
    }
  }

  @Test func verificationHTTPClientsReadOnlyThePrivateFileToken() async throws {
    try await withRoot { root, environment in
      let token = "private-file-token-012345678901234567890"
      let server = try AppTokenHTTPServer(expectedToken: token)
      defer { server.close() }
      var input = environment
      input["BOTS_PORT"] = String(server.port)
      input["BOTS_TOKEN"] = "inherited-token-must-not-cross-profile-012345"
      input["BOTS_OPEN"] = "1"
      let launch = try AppLaunchConfiguration(environment: input)
      let domain = try #require(launch.preferencesDomain)
      try #require(launch.defaults !== UserDefaults.standard)
      defer { launch.defaults.removePersistentDomain(forName: domain) }
      try token.write(
        to: launch.botsSettings.rootURL.appendingPathComponent("token"),
        atomically: true, encoding: .utf8)
      try await exerciseHTTPClients(settings: launch.botsSettings, root: root)
      #expect(server.requests.count == 5)
      #expect(server.requests.allSatisfy { $0.usesExpectedToken })
    }
  }

  private func exerciseHTTPClients(settings: BotsSettings, root: URL) async throws {
    let model = SettingsViewModel(botsSettings: settings)
    await model.loadGateway()
    #expect(model.gateway?.configured == false)
    let app = try await BotsWorkspaceViewModel.liveApp(
      settings: settings,
      makeOutbox: { OutboxStore(directory: root.appendingPathComponent("http-outbox")) })
    let window = BotsWorkspaceViewModel(settings: settings, makeApp: { _ in app })
    defer { window.disconnect() }
    await window.start()
    #expect(window.isConnected)
    let grants = try await BotRemoteAccess.port(settings: settings).read(botID: "fixture-bot")
    #expect(grants.targets.isEmpty)
  }

  @Test func initialBotSelectionUsesTheSelectedEnvironment() async throws {
    try await withRoot { root, _ in
      for flag in ["0", "1"] {
        let catalog = StubCatalog()
        catalog.bots = [
          BotSummary(
            id: "fixture-bot", title: "Fixture", createdAt: "x", updatedAt: "x",
            model: ModelRef(provider: "fixture", modelId: "fixture"), state: .idle),
          BotSummary(
            id: "already-selected", title: "Prior selection", createdAt: "x", updatedAt: "x",
            model: ModelRef(provider: "fixture", modelId: "fixture"), state: .idle),
        ]
        let outbox = OutboxStore(directory: root.appendingPathComponent(flag))
        let app = AppViewModel(
          catalog: catalog,
          conversation: ConversationViewModel(conversation: StubConversation(), outbox: outbox),
          outbox: outbox)
        app.select("already-selected")
        let window = BotsWorkspaceViewModel(
          settings: BotsSettings(environment: ["BOTS_OPEN": flag]),
          makeApp: { _ in app }, gatewayProbe: { true })
        await window.start()
        #expect(window.selectedId == (flag == "1" ? "fixture-bot" : "already-selected"))
        window.disconnect()
      }
    }
  }

  @Test func invalidOrPartialVerificationCannotSelectDailyStores() async throws {
    #expect(throws: AppLaunchError.invalidVerification) {
      try AppLaunchConfiguration(environment: ["EAGLE_APP_VERIFICATION_CONNECT_BOTS": "1"])
    }
    try await withRoot { root, environment in
      for port in ["", "0", "43117", "65536", "invalid", " 52117"] {
        var input = environment
        input["BOTS_PORT"] = port
        #expect(throws: AppLaunchError.invalidVerification) {
          try AppLaunchConfiguration(environment: input)
        }
      }
      for path in ["relative", root.appendingPathComponent("absent").path] {
        var input = environment
        input["EAGLE_APP_VERIFICATION_ROOT"] = path
        #expect(throws: AppLaunchError.invalidVerification) {
          try AppLaunchConfiguration(environment: input)
        }
      }
      let alias = root.appendingPathComponent("alias")
      try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
      var input = environment
      input["EAGLE_APP_VERIFICATION_ROOT"] = alias.path
      #expect(throws: AppLaunchError.invalidVerification) {
        try AppLaunchConfiguration(environment: input)
      }
      input = environment
      input["EAGLE_APP_VERIFICATION_CONNECT_BOTS"] = "yes"
      #expect(throws: AppLaunchError.invalidVerification) {
        try AppLaunchConfiguration(environment: input)
      }
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
      #expect(throws: AppLaunchError.invalidVerification) {
        try AppLaunchConfiguration(environment: environment)
      }
    }
  }
}

/// A loopback HTTP peer records only whether each real header matched; never its value.
final class AppTokenHTTPServer: @unchecked Sendable {
  struct Request {
    let path: String
    let usesExpectedToken: Bool
  }
  private let listener: NWListener
  private let queue = DispatchQueue(label: "eagle-app-token-http-fixture")
  private let lock = NSLock()
  private let expectedToken: String
  private let reply: (@Sendable (String) -> (status: Int, body: String))?
  private var recorded: [Request] = []
  var port: UInt16 { listener.port!.rawValue }
  var requests: [Request] { lock.withLock { recorded } }

  init(
    expectedToken: String,
    reply: (@Sendable (String) -> (status: Int, body: String))? = nil
  ) throws {
    self.expectedToken = expectedToken
    self.reply = reply
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready, .failed: ready.signal()
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else {
        connection.cancel()
        return
      }
      connection.start(queue: queue)
      receive(connection, data: Data())
    }
    listener.start(queue: queue)
    guard ready.wait(timeout: .now() + 5) == .success, listener.port != nil else {
      listener.cancel()
      throw URLError(.cannotConnectToHost)
    }
  }

  private func receive(_ connection: NWConnection, data: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) {
      [weak self] part, _, finished, error in
      guard let self, error == nil else {
        connection.cancel()
        return
      }
      let combined = data + (part ?? Data())
      let text = String(decoding: combined, as: UTF8.self)
      guard text.contains("\r\n\r\n") else {
        if finished || combined.count > 16_384 {
          connection.cancel()
        } else {
          receive(connection, data: combined)
        }
        return
      }
      let lines = text.components(separatedBy: "\r\n")
      let path = lines.first?.split(separator: " ").dropFirst().first.map(String.init) ?? ""
      let header = lines.first { $0.lowercased().hasPrefix("authorization:") }
      let token = header?.dropFirst("authorization:".count)
        .trimmingCharacters(in: .whitespaces)
      lock.withLock {
        recorded.append(Request(path: path, usesExpectedToken: token == "Bearer \(expectedToken)"))
      }
      let body: String
      switch path {
      case "/v1/settings":
        body =
          #"{"settings":{"configured":false,"provider":"raven","baseUrl":"","model":"","hasApiKey":false}}"#
      case "/v1/bots": body = #"{"bots":[],"groups":[]}"#
      default:
        body =
          "{\"remoteTools\":{\"namespace\":\"\(String(repeating: "a", count: 64))\",\"revision\":\"r1\",\"helperAvailable\":true,\"cleanupPending\":false,\"targets\":[]}}"
      }
      let result = reply?(path) ?? (status: 200, body: body)
      guard result.status != 0 else {
        connection.cancel()
        return
      }
      let response =
        "HTTP/1.1 \(result.status) Fixture\r\nContent-Type: application/json\r\nContent-Length: \(result.body.utf8.count)\r\nConnection: close\r\n\r\n\(result.body)"
      connection.send(
        content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }
  }

  func close() { listener.cancel() }
}
