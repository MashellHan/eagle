import BotsCore
import XCTest

/// The domain types are the ones the wire uses, so their codec is round-tripped here:
/// every block kind, every delta kind, the streaming pointer and the ranked submission.
final class DomainTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
  }

  func testEveryContentBlockRoundTrips() throws {
    let blocks: [ContentBlock] = [
      .text("巴黎"),
      .thinking("想一想"),
      .toolCall(callId: "c_1", name: "search"),
      .toolResult(callId: "c_1", text: "结果", isError: false),
    ]
    for block in blocks {
      let data = try JSONEncoder().encode(block)
      let decoded = try JSONDecoder().decode(ContentBlock.self, from: data)
      XCTAssertEqual(decoded, block)
    }
    XCTAssertEqual(ContentBlock.text("巴黎").displayText, "巴黎")
    XCTAssertEqual(ContentBlock.thinking("想一想").displayText, "想一想")
    XCTAssertEqual(
      ContentBlock.toolResult(callId: "c", text: "结果", isError: true).displayText, "结果")
    XCTAssertEqual(ContentBlock.toolCall(callId: "c", name: "n").displayText, "")
  }

  func testEveryDeltaKindRoundTrips() throws {
    let message = Message(
      id: "p_a1",
      role: .assistant,
      state: .streaming,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [.text("巴黎")]
    )
    let changes: [DeltaChange] = [
      .text(index: 0, append: "首都"),
      .thinking(index: 1, append: "想"),
      .block(index: 0, block: .text("巴黎是法国的首都")),
      .message(message),
    ]
    for change in changes {
      let data = try JSONEncoder().encode(change)
      let decoded = try JSONDecoder().decode(DeltaChange.self, from: data)
      XCTAssertEqual(decoded, change)
    }
  }

  func testASnapshotDecodesTheStreamingPointerAndPending() throws {
    let snapshot = try decode(
      ConversationSnapshot.self,
      """
      {
        "botId": "b_1",
        "messages": [],
        "streaming": { "messageId": "p_a2" },
        "pending": [{ "requestId": "r_1", "submissionId": "s_3", "status": "queued" }],
        "inbox": [{ "id": "s_4", "mode": "followUp" }],
        "running": true
      }
      """
    )
    XCTAssertEqual(snapshot.streaming, "p_a2")
    XCTAssertEqual(snapshot.pending.first?.id, "s_3", "pending names the record by submissionId")
    XCTAssertEqual(snapshot.inbox.first?.mode, "followUp")
    XCTAssertTrue(snapshot.running)
  }

  func testASnapshotWithoutAStreamingAttemptEncodesNull() throws {
    let snapshot = ConversationSnapshot(botId: "b_1", running: false)
    let data = try JSONEncoder().encode(snapshot)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    XCTAssertTrue(object?["streaming"] is NSNull, "null means no attempt is in flight")
    XCTAssertEqual(snapshot.streaming, nil)
  }

  func testSubmissionRankAndTerminality() {
    XCTAssertLessThan(SubmissionStatus.queued.rank, SubmissionStatus.placed.rank)
    XCTAssertLessThan(SubmissionStatus.placed.rank, SubmissionStatus.done.rank)
    XCTAssertEqual(SubmissionStatus.done.rank, SubmissionStatus.unanswered.rank)
    XCTAssertTrue(SubmissionStatus.done.isTerminal)
    XCTAssertTrue(SubmissionStatus.unanswered.isTerminal)
    XCTAssertFalse(SubmissionStatus.placed.isTerminal)
  }

  func testAMessageTextJoinsItsBlocksAndKnowsAProvisional() throws {
    let message = try decode(
      Message.self,
      """
      {
        "id": "p_a1",
        "role": "assistant",
        "state": "streaming",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "blocks": [
          { "type": "text", "text": "巴黎" },
          { "type": "thinking", "text": "想" }
        ]
      }
      """
    )
    XCTAssertEqual(message.text, "巴黎想")
    XCTAssertTrue(message.isProvisional)
    XCTAssertFalse(message.isOptimistic)
    XCTAssertEqual(message.stopReason, nil)
  }

  func testAnUnknownBlockOrDeltaIsRefused() {
    XCTAssertThrowsError(
      try decode(ContentBlock.self, #"{"type":"video","text":"x"}"#)
    )
    XCTAssertThrowsError(
      try decode(DeltaChange.self, #"{"kind":"shrug","index":0}"#)
    )
  }

  func testAnOptimisticMessageCarriesItsRequestId() {
    let message = Message.optimistic(requestId: "r_1", text: "问题")
    XCTAssertEqual(message.id, "local_r_1")
    XCTAssertEqual(message.requestId, "r_1")
    XCTAssertTrue(message.isOptimistic)
    XCTAssertEqual(message.role, .user)
  }

  func testIdentifiersFitTheWireRules() {
    let trace = Identifiers.trace("send")
    let request = Identifiers.request()
    let allowed = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{8,64}$")
    for value in [trace, request] {
      let range = NSRange(location: 0, length: value.utf16.count)
      XCTAssertNotNil(allowed.firstMatch(in: value, range: range), "\(value) is wire-legal")
    }
    XCTAssertNotEqual(trace, Identifiers.trace("send"))
  }
}

final class DomainCoverageTests: XCTestCase {
  func testASummaryWithAnUnavailableReasonDecodes() throws {
    let summary = try JSONDecoder().decode(
      BotSummary.self,
      from: Data(
        """
        {"id":"b_1","title":"一","createdAt":"x","updatedAt":"x","state":"unavailable",
         "model":{"provider":"p","modelId":"m"},
         "unavailable":{"reason":"storage_failed","message":"no session"}}
        """.utf8
      )
    )
    XCTAssertEqual(summary.state, .unavailable)
    XCTAssertEqual(summary.unavailable?.reason, .storageFailed)
    XCTAssertEqual(summary.unavailable?.message, "no session")
  }

  func testAMessageCarriesItsStopReasonAndSubmissionItsOptionalIds() throws {
    let message = try JSONDecoder().decode(
      Message.self,
      from: Data(
        """
        {"id":"e_10","role":"assistant","state":"complete","createdAt":"x",
         "stopReason":"length","blocks":[{"type":"text","text":"一半"}]}
        """.utf8
      )
    )
    XCTAssertEqual(message.stopReason, .length)

    let submission = try JSONDecoder().decode(
      Submission.self,
      from: Data(
        #"{"id":"s_1","requestId":"r_1","status":"unanswered","reason":"aborted"}"#.utf8
      )
    )
    XCTAssertEqual(submission.status, .unanswered)
    XCTAssertEqual(submission.reason, "aborted")
    XCTAssertNil(submission.entryId)

    let encoded = try JSONEncoder().encode(submission)
    let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    XCTAssertEqual(object?["submissionId"] as? String, "s_1", "the wire calls it submissionId")
  }

  func testTheSmallValueTypesCoverTheirCases() {
    XCTAssertEqual(BusyMode.followUp.rawValue, "followUp")
    XCTAssertEqual(ErrorKind.internalError.rawValue, "internal")
    XCTAssertEqual(ErrorDisposition.notAdmitted.rawValue, "not_admitted")
    XCTAssertEqual(BotState.quarantined.rawValue, "quarantined")
    XCTAssertEqual(MessageRole.notice.rawValue, "notice")
    XCTAssertEqual(MessageState.aborted.rawValue, "aborted")
    XCTAssertEqual(
      HistoryPage(messages: [], hasMore: true), HistoryPage(messages: [], hasMore: true))
    XCTAssertEqual(InboxItem(id: "s_1", mode: "steer"), InboxItem(id: "s_1", mode: "steer"))
    XCTAssertEqual(ClientError("x").description, "x")
    XCTAssertEqual(CommandContext.command("t").requestId, nil)
    XCTAssertNotNil(CommandContext.command("t").trace)
    XCTAssertTrue(CommandContext.send("r_1").requestId == "r_1")
    XCTAssertEqual(ConversationState(botId: "b").isBusy, false)
    XCTAssertNil(ConversationState(botId: "b").streamingMessage)
    let busy = ConversationState(
      botId: "b",
      messages: [
        Message(
          id: "p_a1",
          role: .assistant,
          state: .streaming,
          createdAt: "x",
          blocks: [.text("…")]
        )
      ],
      streaming: "p_a1",
      running: true
    )
    XCTAssertTrue(busy.isBusy)
    XCTAssertEqual(busy.streamingMessage?.id, "p_a1")
  }
}

final class DomainCoverageMoreTests: XCTestCase {
  func testTheSnapshotRoundTripsThroughTheCodec() throws {
    let snapshot = ConversationSnapshot(
      botId: "b_1",
      messages: [
        Message(
          id: "e_7",
          role: .user,
          state: .complete,
          createdAt: "x",
          blocks: [.text("问")],
          requestId: "r_1"
        )
      ],
      truncatedBefore: "e_3",
      streaming: nil,
      pending: [Submission(id: "s_1", requestId: "r_2", status: .queued)],
      inbox: [InboxItem(id: "s_2", mode: "steer")],
      running: true,
      unavailable: nil
    )
    let data = try JSONEncoder().encode(snapshot)
    let decoded = try JSONDecoder().decode(ConversationSnapshot.self, from: data)
    XCTAssertEqual(decoded, snapshot)
    XCTAssertEqual(decoded.messages.first?.visibleText, "问")
  }

  func testASparseSnapshotUsesTheDocumentedDefaults() throws {
    let decoded = try JSONDecoder().decode(
      ConversationSnapshot.self,
      from: Data(#"{"botId":"b_1"}"#.utf8)
    )
    XCTAssertEqual(decoded.messages, [])
    XCTAssertEqual(decoded.pending, [])
    XCTAssertEqual(decoded.inbox, [])
    XCTAssertFalse(decoded.running)
    XCTAssertNil(decoded.streaming)
  }

  func testASummaryRoundTripsWithItsLabelAndFace() throws {
    let summary = BotSummary(
      id: "b_1",
      title: "研究员",
      label: "研究",
      appearance: BotAppearance(shape: .flower, tint: .pink),
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .unavailable,
      unavailable: BotUnavailable(reason: .storageFailed, message: "closed")
    )
    let data = try JSONEncoder().encode(summary)
    let decoded = try JSONDecoder().decode(BotSummary.self, from: data)
    XCTAssertEqual(decoded, summary)
    XCTAssertEqual(decoded.face.shape, .flower)
  }

  func testAToolCallDeltaCarriesAnIndexedPath() throws {
    let change = DeltaChange.toolCall(
      index: 2,
      callId: "c_1",
      path: ["args", "0"],
      append: "x"
    )
    let data = try JSONEncoder().encode(change)
    let decoded = try JSONDecoder().decode(DeltaChange.self, from: data)
    XCTAssertEqual(decoded, change)
  }

  func testVisibleTextIgnoresThinkingAndTools() {
    let message = Message(
      id: "e_10",
      role: .assistant,
      state: .complete,
      createdAt: "x",
      blocks: [
        .thinking("想"),
        .text("答"),
        .toolResult(callId: "c", text: "果", isError: false),
      ]
    )
    XCTAssertEqual(message.visibleText, "答")
    XCTAssertEqual(message.text, "想答果")
  }
}
