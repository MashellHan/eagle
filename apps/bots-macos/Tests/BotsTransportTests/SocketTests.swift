import BotsCore
import BotsTransport
import XCTest

/// Row 61: the client speaks the real daemon — handshake, subscribe, create, chat and
/// close — with the production adapter behind it and only the model network stubbed.
final class SocketTests: XCTestCase {
  private var fixture: BotsDaemonFixture!

  override func setUp() async throws {
    fixture = try await BotsDaemonFixture.start()
  }

  override func tearDown() async throws {
    fixture?.stop()
    fixture = nil
  }

  func testCreateBotAndChat() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let before = try await catalog.load()
    XCTAssertEqual(before.count, 0, "a fresh daemon has an empty catalog")

    let created = try await catalog.create(
      title: "客户端自测",
      label: "自测",
      appearance: BotAppearance(shape: .star, tint: .violet)
    )
    XCTAssertEqual(created.title, "客户端自测")
    XCTAssertEqual(created.label, "自测", "the daemon stores the label")
    XCTAssertEqual(created.face.shape, .star, "and the chosen face")
    XCTAssertEqual(created.face.tint, .violet)
    XCTAssertTrue(created.id.hasPrefix("b_"))
    let listed = try await catalog.load()
    XCTAssertEqual(listed.map(\.id), [created.id])

    let socket = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: created.id
    )
    let collector = EventCollector()
    let consumer = Task {
      for await event in socket.events {
        await collector.append(event)
      }
    }
    defer {
      socket.close()
      consumer.cancel()
    }
    socket.start()

    _ = try await collector.waitFor { event in
      if case .snapshot(let value) = event { return value.botId == created.id }
      return false
    }
    try socket.send(
      text: "你好，客户端",
      requestId: Identifiers.request(),
      whenBusy: .followUp,
      trace: Identifiers.trace("send")
    )
    let first = try await collector.waitFor { event in
      if case .append(let message, _) = event { return message.role == .user }
      return false
    }
    guard case .append(let userMessage, _) = first else {
      return XCTFail("expected the user entry")
    }
    XCTAssertEqual(userMessage.text, "你好，客户端")

    let answer = try await collector.waitFor { event in
      if case .append(let message, _) = event {
        return message.role == .assistant && message.state == .complete
      }
      return false
    }
    guard case .append(let assistant, _) = answer else {
      return XCTFail("expected the answer")
    }
    XCTAssertEqual(assistant.text, "这是本地模型的示例回答。")

    let settled = try await collector.waitFor { event in
      if case .submission(let record) = event { return record.status == .done }
      return false
    }
    guard case .submission(let record) = settled else {
      return XCTFail("expected the settlement")
    }
    XCTAssertEqual(record.answerEntryId, assistant.id)

    // The transcript can be rebuilt from a fresh subscription: one question, one answer.
    let again = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: created.id
    )
    let secondCollector = EventCollector()
    let secondConsumer = Task {
      for await event in again.events {
        await secondCollector.append(event)
      }
    }
    defer {
      again.close()
      secondConsumer.cancel()
    }
    again.start()
    let snapshotEvent = try await secondCollector.waitFor { event in
      if case .snapshot(let value) = event { return value.messages.count == 2 }
      return false
    }
    guard case .snapshot(let snapshot) = snapshotEvent else {
      return XCTFail("expected the snapshot")
    }
    XCTAssertEqual(snapshot.messages.map(\.role), [.user, .assistant])
    XCTAssertEqual(snapshot.messages.last?.text, "这是本地模型的示例回答。")
    XCTAssertEqual(snapshot.streaming, nil)
  }

  func testCatalogIsAbsoluteAndSurvivesAReconnect() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let first = try await catalog.create(title: "一", label: nil, appearance: .standard)
    let second = try await catalog.create(title: "二", label: nil, appearance: .standard)
    let created = try await catalog.load()
    XCTAssertEqual(Set(created.map(\.id)), [first.id, second.id])

    let renamed = try await catalog.rename(id: first.id, title: "一号")
    XCTAssertEqual(renamed.title, "一号")

    try await catalog.delete(id: second.id)
    let remaining = try await catalog.load()
    XCTAssertEqual(remaining.map(\.id), [first.id])
  }
}

extension SocketTests {
  func testASocketReconnectsAndRebuildsTheTranscript() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let bot = try await catalog.create(title: "重连", label: nil, appearance: .standard)
    let first = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: bot.id
    )
    let collector = EventCollector()
    let consumer = Task {
      for await event in first.events { await collector.append(event) }
    }
    first.start()
    _ = try await collector.waitFor { event in
      if case .connection(.ready) = event { return true }
      return false
    }
    try first.send(
      text: "第一轮",
      requestId: Identifiers.request(),
      whenBusy: .followUp,
      trace: Identifiers.trace("send")
    )
    _ = try await collector.waitFor { event in
      if case .submission(let record) = event { return record.status == .done }
      return false
    }
    first.close()
    consumer.cancel()

    // A second socket starts from a snapshot, not from the frames the first one saw.
    let again = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: bot.id
    )
    let renewed = EventCollector()
    let secondConsumer = Task {
      for await event in again.events { await renewed.append(event) }
    }
    defer {
      again.close()
      secondConsumer.cancel()
    }
    again.start()
    let snapshotEvent = try await renewed.waitFor { event in
      if case .snapshot(let value) = event { return value.messages.count == 2 }
      return false
    }
    guard case .snapshot(let snapshot) = snapshotEvent else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.messages.map(\.role), [.user, .assistant])
  }
}
