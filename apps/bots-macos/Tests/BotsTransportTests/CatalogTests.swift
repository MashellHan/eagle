import BotsCore
import BotsTransport
import XCTest

/// A URLProtocol stub: the catalog client's status, error and decoding paths without a
/// daemon.
final class StubProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (Int, Data))?
  static var lastAuthorization: String?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.lastAuthorization = request.value(forHTTPHeaderField: "Authorization")
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: ClientError("no handler"))
      return
    }
    do {
      let (status, data) = try handler(request)
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
      )!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

final class CatalogHTTPClientTests: XCTestCase {
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

  private func bot(_ id: String, _ title: String) -> String {
    """
    {"id":"\(id)","title":"\(title)","createdAt":"x","updatedAt":"x",
     "model":{"provider":"faux","modelId":"faux-1"},"state":"idle"}
    """
  }

  func testLoadCreateRenameAndDeleteSpeakTheDocumentedShape() async throws {
    StubProtocol.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/bots"):
        return (200, Data("{\"bots\":[\(self.bot("b_1", "一"))]}".utf8))
      case ("POST", "/v1/bots"):
        return (201, Data("{\"bot\":\(self.bot("b_2", "二"))}".utf8))
      case ("PATCH", "/v1/bots/b_1"):
        return (200, Data("{\"bot\":\(self.bot("b_1", "改"))}".utf8))
      case ("DELETE", "/v1/bots/b_1"):
        return (204, Data())
      default:
        return (404, Data())
      }
    }
    let loaded = try await client.load()
    XCTAssertEqual(loaded.map(\.id), ["b_1"])
    let created = try await client.create(title: "二")
    XCTAssertEqual(created.id, "b_2")
    let renamed = try await client.rename(id: "b_1", title: "改")
    XCTAssertEqual(renamed.title, "改")
    try await client.delete(id: "b_1")
    XCTAssertEqual(StubProtocol.lastAuthorization, "Bearer test-token-0123456789")
  }

  func testARejectedTokenIsASetupError() async {
    StubProtocol.handler = { _ in (401, Data()) }
    await expectThrows({ try await self.client.load() }) { error in
      XCTAssertEqual((error as? ClientError)?.message, "the daemon rejected the token")
    }
  }

  func testAnErrorBodyAndAnUnknownStatusAreReported() async {
    StubProtocol.handler = { _ in
      (409, Data("{\"error\":{\"kind\":\"internal\",\"message\":\"the bot is quarantined\"}}".utf8))
    }
    await expectThrows({ try await self.client.load() }) { error in
      XCTAssertEqual((error as? ClientError)?.message, "the bot is quarantined")
    }

    StubProtocol.handler = { _ in (500, Data("boom".utf8)) }
    await expectThrows({ try await self.client.load() }) { error in
      XCTAssertEqual((error as? ClientError)?.message, "the daemon answered 500")
    }
  }

  func testAReadableButWrongBodyIsReportedAndAnUnreachableDaemonToo() async {
    StubProtocol.handler = { _ in (200, Data("{}".utf8)) }
    await expectThrows({ try await self.client.load() }) { error in
      XCTAssertTrue(
        (error as? ClientError)?.message.contains("cannot read") == true
      )
    }

    StubProtocol.handler = { _ in throw ClientError("connection refused") }
    await expectThrows({ try await self.client.load() }) { _ in }
  }
}

private func expectThrows(
  _ expression: () async throws -> Any,
  handler: (Error) -> Void
) async {
  do {
    _ = try await expression()
    XCTFail("expected an error")
  } catch {
    handler(error)
  }
}
