import BotsCore
import BotsFeatures
import Foundation
import XCTest

@MainActor
final class ConversationTests: XCTestCase {
  private var outboxDirectory: URL!

  override func setUp() async throws {
    outboxDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-outbox-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: outboxDirectory)
  }

  private func makeModel(
    botId: String = "b_1"
  ) -> (ConversationViewModel, FakeConversation, OutboxStore) {
    let conversation = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = ConversationViewModel(botId: botId, conversation: conversation, outbox: outbox)
    return (model, conversation, outbox)
  }

  private func ready(_ model: ConversationViewModel) {
    model.select(botId: "b_1")
  }

  func testComposerSendsOptimisticallyAndTheEntryReplacesTheBubble() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }

    model.draft = "法国的首都是哪里？"
    model.send()

    XCTAssertEqual(model.draft, "", "the composer clears when the send leaves")
    XCTAssertEqual(model.state.messages.count, 1, "the bubble is shown before the daemon answers")
    XCTAssertTrue(model.state.messages[0].isOptimistic)
    XCTAssertEqual(outbox.entries(for: "b_1").count, 1, "the outbox is stored before the frame")
    let requestId = try XCTUnwrap(outbox.entries(for: "b_1").first?.requestId)
    try await waitUntil { fake.sent.count == 1 }
    XCTAssertEqual(fake.sent.last?.requestId, requestId)

    fake.emit(
      .append(
        message: Message(
          id: "e_7",
          role: .user,
          state: .complete,
          createdAt: "2026-01-01T00:00:00.000Z",
          blocks: [.text("法国的首都是哪里？")],
          requestId: requestId
        ),
        replaces: nil
      )
    )
    fake.emit(
      .submission(
        Submission(
          id: "s_1", requestId: requestId, status: .done, entryId: "e_7", answerEntryId: "e_10")
      )
    )
    try await waitUntil { model.state.messages.count == 1 && !model.state.messages[0].isOptimistic }
    XCTAssertEqual(model.state.messages[0].id, "e_7")
    XCTAssertEqual(outbox.entries(for: "b_1").count, 0, "a terminal record removes the entry")
  }

  func testNotAdmittedRemovesTheBubbleAndTheOutboxEntry() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    model.draft = "太长"
    model.send()
    let requestId = try XCTUnwrap(outbox.entries(for: "b_1").first?.requestId)

    fake.emit(
      .error(
        kind: .limitExceeded,
        disposition: .notAdmitted,
        message: "the command was refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await waitUntil { model.state.messages.isEmpty }
    XCTAssertEqual(outbox.entries(for: "b_1").count, 0, "a refusal clears the entry")
    XCTAssertEqual(model.draft, "太长", "and the text comes back so it can be fixed")
    XCTAssertNotNil(model.errorBanner)
  }

  func testAnUnconfirmedAdmissionKeepsTheOutboxEntry() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    model.draft = "重要的问题"
    model.send()
    let requestId = try XCTUnwrap(outbox.entries(for: "b_1").first?.requestId)

    fake.emit(
      .error(
        kind: .internalError,
        disposition: .unknown,
        message: "admission could not be confirmed",
        failure: "f_2",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(
      outbox.entries(for: "b_1").count,
      1,
      "an unknown outcome keeps the entry for a retry with the same requestId"
    )
  }

  func testASessionFailureShowsUnavailableAndRecoverAsksTheDaemon() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    fake.emit(
      .error(
        kind: .storageFailed,
        disposition: .runtime,
        message: "the session closed",
        failure: "f_3",
        requestId: nil
      )
    )
    try await waitUntil { model.state.unavailable != nil }
    XCTAssertTrue(model.state.messages.isEmpty)
    XCTAssertFalse(model.canSend)

    model.recover()
    try await waitUntil { fake.recovered == 1 }
  }

  func testTheStoredOutboxIsReplayedAfterTheFirstSnapshot() async throws {
    let outbox = OutboxStore(directory: outboxDirectory)
    let stored = OutboxEntry(botId: "b_1", requestId: "r_stored_1", text: "断网时写的")
    try outbox.add(stored)
    let fake = FakeConversation()
    let model = ConversationViewModel(botId: "b_1", conversation: fake, outbox: outbox)
    ready(model)
    fake.emit(.connection(.ready))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(fake.sent.isEmpty, "a send before the subscription would be refused")

    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { fake.sent.contains { $0.requestId == "r_stored_1" } }
    XCTAssertEqual(
      fake.sent.last?.text,
      "断网时写的",
      "reconciliation re-sends the stored entry with its original requestId"
    )
  }

  private func waitUntil(
    _ condition: () -> Bool,
    timeout: TimeInterval = 2
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("condition not met within \(timeout) s")
  }
}

final class FakeConversation: ConversationPort {
  struct Sent {
    let text: String
    let requestId: String
  }

  var sent: [Sent] = []
  var lastBotId: String?
  var recovered = 0
  var aborted = 0
  var historyRequests: [String] = []
  private var continuation: AsyncStream<ConversationEvent>.Continuation?

  func open(botId: String) -> AsyncStream<ConversationEvent> {
    AsyncStream { continuation in
      self.continuation = continuation
    }
  }

  func emit(_ event: ConversationEvent) {
    continuation?.yield(event)
  }

  func send(
    _ text: String,
    whenBusy: BusyMode,
    context: CommandContext,
    botId: String
  ) async throws {
    sent.append(Sent(text: text, requestId: context.requestId ?? ""))
    lastBotId = botId
  }

  func abort(context: CommandContext, botId: String) async throws {
    aborted += 1
    lastBotId = botId
  }

  func recover(context: CommandContext, botId: String) async throws {
    recovered += 1
    lastBotId = botId
  }

  func resync(context: CommandContext, botId: String) async throws {
    lastBotId = botId
  }

  func loadHistory(before messageId: String, context: CommandContext, botId: String) async throws {
    historyRequests.append(messageId)
    lastBotId = botId
  }

  func close() {
    continuation?.finish()
    continuation = nil
  }
}

@MainActor
final class ConversationLifecycleTests: XCTestCase {
  private func make() -> (ConversationViewModel, FakeConversation) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-life-\(UUID().uuidString)", isDirectory: true)
    let conversation = FakeConversation()
    let model = ConversationViewModel(
      botId: "b_1",
      conversation: conversation,
      outbox: OutboxStore(directory: directory)
    )
    return (model, conversation)
  }

  func testSendingRequiresAReadyConnectionAndANonEmptyDraft() async throws {
    let (model, fake) = make()
    model.draft = "还没连接"
    model.send()
    XCTAssertTrue(fake.sent.isEmpty, "a draft before the handshake is not sent")
    XCTAssertEqual(model.draft, "还没连接", "and the text stays in the composer")

    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    try await Task.sleep(nanoseconds: 30_000_000)
    model.draft = "   "
    model.send()
    XCTAssertTrue(fake.sent.isEmpty, "a blank draft is not sent")

    model.draft = "好"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(fake.sent.count, 1)
  }

  func testAbortRecoverAndHistoryGoThroughThePort() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(
      .snapshot(
        ConversationSnapshot(
          botId: "b_1",
          messages: [
            Message(
              id: "e_7",
              role: .user,
              state: .complete,
              createdAt: "x",
              blocks: [.text("旧")],
              requestId: "r_1"
            )
          ],
          truncatedBefore: "e_7"
        )
      )
    )
    try await Task.sleep(nanoseconds: 30_000_000)
    model.abort()
    model.recover()
    model.loadOlder()
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(fake.aborted, 1)
    XCTAssertEqual(fake.recovered, 1)
    XCTAssertEqual(fake.historyRequests, ["e_7"])
  }

  func testAStatusAndADeltaUpdateTheTranscriptLive() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.status(running: true, inbox: [], streaming: "p_a1"))
    fake.emit(
      .append(
        message: Message(
          id: "p_a1",
          role: .assistant,
          state: .streaming,
          createdAt: "x",
          blocks: [.text("")]
        ),
        replaces: nil
      )
    )
    fake.emit(.delta(messageId: "p_a1", changes: [.text(index: 0, append: "巴黎")]))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.state.running)
    XCTAssertEqual(model.state.streaming, "p_a1")
    XCTAssertEqual(model.state.messages.first?.text, "巴黎")
  }

  func testACatalogEventIsForwardedAndAnErrorCanBeDismissed() async throws {
    let (model, fake) = make()
    var forwarded: [BotSummary]?
    model.onCatalog = { forwarded = $0 }
    model.select(botId: "b_1")
    fake.emit(
      .catalog([
        BotSummary(
          id: "b_1",
          title: "一",
          createdAt: "x",
          updatedAt: "x",
          model: ModelRef(provider: "p", modelId: "m"),
          state: .idle
        )
      ])
    )
    fake.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: nil
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(forwarded?.map(\.id), ["b_1"])
    XCTAssertEqual(model.errorBanner, "refused")
    model.dismissError()
    XCTAssertNil(model.errorBanner)
  }

  func testARefusalKeepsARejectedTextAndANewerDraft() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 40_000_000)
    model.draft = "A"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    model.draft = "B"
    fake.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.draft.contains("A"), "the refused text is recoverable")
    XCTAssertTrue(model.draft.contains("B"), "and the newer draft is not overwritten")
  }

  func testAReconnectReconcilesTheOutboxAgain() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 40_000_000)
    model.draft = "第一次"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    let firstSends = fake.sent.count

    fake.emit(.connection(.reconnecting(attempt: 1)))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 60_000_000)
    XCTAssertGreaterThan(
      fake.sent.count,
      firstSends,
      "the stored request is re-sent with its original requestId after a reconnect"
    )
    XCTAssertEqual(
      fake.sent.last?.requestId,
      fake.sent.first?.requestId,
      "reconciliation never invents a new request id"
    )
  }

  func testRetryReusesTheStoredRequestId() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-retry-\(UUID().uuidString)", isDirectory: true)
    let fake = FakeConversation()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(botId: "b_1", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    try await Task.sleep(nanoseconds: 30_000_000)
    model.retry(OutboxEntry(botId: "b_1", requestId: "r_retry_1", text: "再发一次"))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(fake.sent.last?.requestId, "r_retry_1")
    XCTAssertEqual(fake.sent.last?.text, "再发一次")
  }
}
