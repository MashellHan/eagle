import BotsCore
import BotsTransport
import XCTest

/// The catalog carries the sidebar's groups and each bot's membership; the four group
/// endpoints and `PATCH /v1/bots/:id {groupId}` speak the documented shapes
/// (docs/bots/PROTOCOL.md, "Group rules").
final class GroupCatalogHTTPTests: XCTestCase {
  private var client: CatalogHTTPClient!

  override func setUp() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    client = CatalogHTTPClient(
      baseURL: URL(string: "http://127.0.0.1:9")!,
      token: "test-token-0123456789",
      session: URLSession(configuration: configuration)
    )
  }

  override func tearDown() {
    StubProtocol.handler = nil
  }

  func testTheCatalogCarriesItsGroupsAndEachBotItsMembership() async throws {
    StubProtocol.handler = { _ in
      (
        200,
        Data(
          """
          {"bots":[
            {"id":"b_1","title":"一","groupId":"g_1","createdAt":"x","updatedAt":"x",
             "model":{"provider":"p","modelId":"m"},"state":"idle"},
            {"id":"b_2","title":"二","createdAt":"x","updatedAt":"x",
             "model":{"provider":"p","modelId":"m"},"state":"idle"}],
           "groups":[{"id":"g_1","title":"工作"},{"id":"g_2","title":"研究"}]}
          """.utf8)
      )
    }
    let catalog = try await client.load()
    XCTAssertEqual(
      catalog.groups,
      [BotGroup(id: "g_1", title: "工作"), BotGroup(id: "g_2", title: "研究")],
      "the catalog keeps the daemon's display order"
    )
    XCTAssertEqual(catalog.bots.map(\.groupId), ["g_1", nil], "an absent membership is ungrouped")
  }

  func testACatalogWithoutGroupsReadsAsNoneInsteadOfFailing() async throws {
    StubProtocol.handler = { _ in
      (
        200,
        Data(
          """
          {"bots":[{"id":"b_1","title":"一","createdAt":"x","updatedAt":"x",
                    "model":{"provider":"p","modelId":"m"},"state":"idle"}]}
          """.utf8)
      )
    }
    let catalog = try await client.load()
    XCTAssertEqual(catalog.groups, [], "a daemon that predates groups still loads")
    XCTAssertEqual(catalog.bots.map(\.id), ["b_1"])
  }

  func testTheGroupWritesSpeakTheDocumentedShape() async throws {
    var bodies: [String: [String: Any]] = [:]
    func capture(_ key: String, _ request: URLRequest) {
      guard let data = bodyData(request),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { return }
      bodies[key] = parsed
    }
    StubProtocol.handler = { request in
      let path = request.url?.path ?? ""
      switch (request.httpMethod, path) {
      case ("POST", "/v1/groups"):
        capture("create", request)
        return (201, Data(#"{"group":{"id":"g_1","title":"工作"}}"#.utf8))
      case ("PATCH", "/v1/groups/g_1"):
        capture("rename", request)
        return (200, Data(#"{"group":{"id":"g_1","title":"上班"}}"#.utf8))
      case ("DELETE", "/v1/groups/g_1"):
        return (204, Data())
      case ("PUT", "/v1/groups/order"):
        capture("order", request)
        return (
          200,
          Data(#"{"groups":[{"id":"g_2","title":"二"},{"id":"g_1","title":"一"}]}"#.utf8)
        )
      case ("PATCH", "/v1/bots/b_1"):
        capture("move", request)
        return (
          200,
          Data(
            """
            {"bot":{"id":"b_1","title":"一","groupId":"g_1","createdAt":"x","updatedAt":"x",
                    "model":{"provider":"p","modelId":"m"},"state":"idle"}}
            """.utf8)
        )
      case ("PATCH", "/v1/bots/b_2"):
        capture("unfile", request)
        return (
          200,
          Data(
            """
            {"bot":{"id":"b_2","title":"二","createdAt":"x","updatedAt":"x",
                    "model":{"provider":"p","modelId":"m"},"state":"idle"}}
            """.utf8)
        )
      default:
        return (404, Data())
      }
    }

    let created = try await client.createGroup(title: "工作")
    XCTAssertEqual(created, BotGroup(id: "g_1", title: "工作"))
    XCTAssertEqual(bodies["create"]?["title"] as? String, "工作")

    let renamed = try await client.renameGroup(id: "g_1", title: "上班")
    XCTAssertEqual(renamed.title, "上班")
    XCTAssertEqual(bodies["rename"]?["title"] as? String, "上班")

    let reordered = try await client.reorderGroups(ids: ["g_2", "g_1"])
    XCTAssertEqual(reordered.map(\.id), ["g_2", "g_1"], "the daemon answers the whole order")
    XCTAssertEqual(bodies["order"]?["ids"] as? [String], ["g_2", "g_1"])

    let filed = try await client.moveBot(id: "b_1", groupId: "g_1")
    XCTAssertEqual(filed.groupId, "g_1")
    XCTAssertEqual(bodies["move"]?["groupId"] as? String, "g_1")

    // `null` is what unfiles a bot; an omitted field would leave it where it is.
    let unfiled = try await client.moveBot(id: "b_2", groupId: nil)
    XCTAssertNil(unfiled.groupId)
    XCTAssertTrue(bodies["unfile"]?.keys.contains("groupId") == true, "the field is sent")
    XCTAssertTrue(bodies["unfile"]?["groupId"] is NSNull, "and it is null")

    try await client.deleteGroup(id: "g_1")
  }

  func testANonEmptyGroupRefusalSurfacesTheDaemonMessage() async {
    StubProtocol.handler = { _ in
      (
        409,
        Data(
          #"{"error":{"kind":"invalid_command","message":"the group still holds bots"}}"#.utf8)
      )
    }
    do {
      try await client.deleteGroup(id: "g_1")
      XCTFail("a 409 is a refusal, not a success")
    } catch {
      XCTAssertEqual((error as? ClientError)?.message, "the group still holds bots")
    }
  }

  func testARefusedTitleSurfacesTheDaemonMessage() async {
    StubProtocol.handler = { _ in
      (
        400,
        Data(#"{"error":{"kind":"invalid_command","message":"a group title is required"}}"#.utf8)
      )
    }
    do {
      _ = try await client.createGroup(title: "   ")
      XCTFail("a 400 is a refusal, not a group")
    } catch {
      XCTAssertEqual((error as? ClientError)?.message, "a group title is required")
    }
  }
}

/// The frames that carry the catalog must agree with the daemon about groups.
final class GroupFrameTests: XCTestCase {
  func testTheWelcomeFrameCarriesGroups() throws {
    let data = Data(
      """
      {"type":"welcome","protocolVersion":1,
       "bots":[{"id":"b_1","title":"一","groupId":"g_1","createdAt":"x","updatedAt":"x",
                "model":{"provider":"p","modelId":"m"},"state":"idle"}],
       "groups":[{"id":"g_1","title":"工作"}]}
      """.utf8)
    let decoded = try Wire.decode(data)
    XCTAssertEqual(decoded.catalog?.groups, [BotGroup(id: "g_1", title: "工作")])
    XCTAssertEqual(decoded.catalog?.bots.map(\.groupId), ["g_1"])
  }

  func testABotsFrameWithoutGroupsReadsAsNone() throws {
    let data = Data(
      """
      {"type":"bots","bots":[{"id":"b_1","title":"一","createdAt":"x","updatedAt":"x",
                              "model":{"provider":"p","modelId":"m"},"state":"idle"}]}
      """.utf8)
    let decoded = try Wire.decode(data)
    XCTAssertEqual(decoded.catalog?.groups, [])
    XCTAssertNil(decoded.catalog?.bots.first?.groupId)
  }

  func testAPushedCatalogEventCarriesTheGroups() throws {
    let data = Data(
      """
      {"type":"bots","bots":[],"groups":[{"id":"g_2","title":"空组"}]}
      """.utf8)
    let decoded = try Wire.decode(data)
    guard case .catalog(let catalog)? = decoded.event else {
      return XCTFail("expected a catalog event")
    }
    XCTAssertEqual(catalog.groups, [BotGroup(id: "g_2", title: "空组")])
    XCTAssertTrue(catalog.bots.isEmpty)
  }
}

/// `URLProtocol` hands a request's body as a stream; a test that inspects it reads it.
private func bodyData(_ request: URLRequest) -> Data? {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return nil }
  stream.open()
  defer { stream.close() }
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 1024)
  while stream.hasBytesAvailable {
    let read = stream.read(&buffer, maxLength: buffer.count)
    if read <= 0 { break }
    data.append(buffer, count: read)
  }
  return data
}
