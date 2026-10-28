import BotsCore
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Bot remote authority HTTP", .serialized)
@MainActor
struct BotRemoteHTTPTests {
  private let token = "fixture-daemon-credential-0123456789012345"
  private var target: BotRemoteTarget {
    BotRemoteTarget(
      alias: "build-mac", enabled: false, origin: "https://machines.example.test",
      machineId: "machine-b", credentialRef: "fixture-reference", operations: [.readFile])
  }
  private func client(base: String = "http://127.0.0.1:43117") -> RemoteToolsHTTPClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RemoteGrantHTTPStub.self]
    return RemoteToolsHTTPClient(
      baseURL: URL(string: base)!, token: token, configuration: configuration)
  }
  private func configuration(targets: [BotRemoteTarget]? = nil) -> BotRemoteConfiguration {
    BotRemoteConfiguration(
      namespace: String(repeating: "a", count: 64), revision: "revision-1",
      helperAvailable: true, cleanupPending: false, targets: targets ?? [target])
  }

  @Test func readsAndSavesOnlyNonSecretAuthority() async throws {
    let saved = configuration()
    var writes = 0
    RemoteGrantHTTPStub.handler = { request in
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
      #expect(request.url?.path == "/v1/bots/bot-a/remote-tools")
      if request.httpMethod == "PUT" {
        writes += 1
        let data = try #require(gatewayHTTPBody(request))
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["revision", "targets"])
        #expect(!String(decoding: data, as: UTF8.self).contains(token))
      }
      return (200, try JSONEncoder().encode(["remoteTools": saved]))
    }
    defer { RemoteGrantHTTPStub.handler = nil }
    #expect(try await client().read(botID: "bot-a") == saved)
    #expect(
      try await client().save(botID: "bot-a", revision: saved.revision, targets: saved.targets)
        == saved)
    #expect(writes == 1)
  }

  @Test func statusCodesStayDistinctAndBodyFailuresAreBounded() async throws {
    for (status, error) in [
      (401, RemoteToolsError.authentication), (409, .conflict), (503, .unavailable),
    ] {
      RemoteGrantHTTPStub.handler = { _ in (status, Data("{}".utf8)) }
      await #expect(throws: error) { try await client().read(botID: "bot-a") }
    }
    for body in [Data("<html>not an API</html>".utf8), Data(repeating: 32, count: 65_537)] {
      RemoteGrantHTTPStub.handler = { _ in (200, body) }
      await #expect(throws: RemoteToolsError.invalid) { try await client().read(botID: "bot-a") }
    }
    RemoteGrantHTTPStub.handler = nil
  }

  @Test func validatesAddressesIdentifiersAndMetadataBeforeSending() async throws {
    var requests = 0
    RemoteGrantHTTPStub.handler = { _ in
      requests += 1
      return (200, Data("{}".utf8))
    }
    defer { RemoteGrantHTTPStub.handler = nil }
    for base in [
      "https://foreign.example.test", "http://127.0.0.1:43117/path", "http://user@127.0.0.1:43117",
    ] {
      await #expect(throws: RemoteToolsError.invalid) {
        try await client(base: base).read(botID: "bot-a")
      }
    }
    for id in ["../bot-b", "bot-a\n", ""] {
      await #expect(throws: RemoteToolsError.invalid) { try await client().read(botID: id) }
    }
    var invalid = target
    invalid.origin = "http://foreign.example.test"
    await #expect(throws: RemoteToolsError.invalid) {
      try await client().save(botID: "bot-a", revision: "rev", targets: [invalid])
    }
    await #expect(throws: RemoteToolsError.invalid) {
      try await client().save(botID: "bot-a", revision: "rev", targets: [target, target])
    }
    let large = (0..<8).map { index in
      BotRemoteTarget(
        alias: "mac-\(index)", enabled: false,
        origin: "https://" + String(repeating: "host.", count: 240) + "test",
        machineId: "machine-b", credentialRef: "fixture-reference-\(index)", operations: [.readFile]
      )
    }
    await #expect(throws: RemoteToolsError.invalid) {
      try await client().save(botID: "bot-a", revision: "rev", targets: large)
    }
    #expect(requests == 0)
  }

  @Test func rejectsInvalidReturnedBindingsAndReadsBotIDs() async throws {
    let invalid = BotRemoteConfiguration(
      namespace: "invalid", revision: "rev", helperAvailable: true, cleanupPending: false,
      targets: [target])
    RemoteGrantHTTPStub.handler = { _ in (200, try JSONEncoder().encode(["remoteTools": invalid])) }
    await #expect(throws: RemoteToolsError.invalid) { try await client().read(botID: "bot-a") }
    RemoteGrantHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/bots")
      return (200, Data(#"{"bots":[{"id":"bot-a","title":"A"},{"id":"bot-b","title":"B"}]}"#.utf8))
    }
    #expect(try await client().botIDs() == ["bot-a", "bot-b"])
    RemoteGrantHTTPStub.handler = { _ in (200, Data(#"{"bots":[{"id":"../foreign"}]}"#.utf8)) }
    await #expect(throws: RemoteToolsError.invalid) { try await client().botIDs() }
    RemoteGrantHTTPStub.handler = nil
  }

  @Test func remoteGroupIsSelectableAndOffByDefault() {
    #expect(!SettingsViewModel.defaultToolGroups.contains("remote"))
    #expect(SettingsViewModel.toolGroups.contains("remote"))
  }

  @Test func knownDaemonCredentialNeverEntersPathsBodiesOrReturnedMetadata() async throws {
    var requests = 0
    let good = configuration()
    RemoteGrantHTTPStub.handler = { _ in
      requests += 1
      return (200, try JSONEncoder().encode(["remoteTools": good]))
    }
    defer { RemoteGrantHTTPStub.handler = nil }
    await #expect(throws: RemoteToolsError.invalid) { try await client().read(botID: token) }
    await #expect(throws: RemoteToolsError.invalid) {
      try await client().save(botID: "bot-a", revision: token, targets: [target])
    }
    for key in [\BotRemoteTarget.alias, \BotRemoteTarget.credentialRef] {
      var poisoned = target
      poisoned[keyPath: key] = token
      await #expect(throws: RemoteToolsError.invalid) {
        try await client().save(botID: "bot-a", revision: "rev", targets: [poisoned])
      }
    }
    #expect(requests == 0, "credential admission must happen before URLSession")
    var returnedTarget = target
    returnedTarget.alias = token
    let poisoned = configuration(targets: [returnedTarget])
    RemoteGrantHTTPStub.handler = { _ in (200, try JSONEncoder().encode(["remoteTools": poisoned]))
    }
    await #expect(throws: RemoteToolsError.invalid) { try await client().read(botID: "bot-a") }
    RemoteGrantHTTPStub.handler = { _ in
      (200, try JSONSerialization.data(withJSONObject: ["bots": [["id": token]]]))
    }
    await #expect(throws: RemoteToolsError.invalid) { try await client().botIDs() }
  }
}

private final class RemoteGrantHTTPStub: URLProtocol {
  private final class State: @unchecked Sendable {
    var handler: ((URLRequest) throws -> (Int, Data))?
  }
  private static let state = State()
  static var handler: ((URLRequest) throws -> (Int, Data))? {
    get { state.handler }
    set { state.handler = newValue }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      guard let handler = Self.handler else { throw URLError(.badURL) }
      let (status, data) = try handler(request)
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
