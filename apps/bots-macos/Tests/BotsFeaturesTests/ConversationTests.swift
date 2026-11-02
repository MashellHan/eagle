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

  func testASequentialCommittedUserReplacesIdleLocalDisplayBeforeAssessment() async throws {
    let remote = FakeNativeHistory()
    remote.extendsCurrent = true
    remote.blockAssessment = true
    let socket = FakeConversation()
    let model = ConversationViewModel(
      conversation: socket,
      outbox: OutboxStore(directory: outboxDirectory.appendingPathComponent(UUID().uuidString)),
      history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    let local = Message(
      id: "local-tail", role: .assistant, state: .complete,
      createdAt: "x", blocks: [.text("A's completed local answer")])
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1", messages: [local])))
    try await waitUntil { model.hasSnapshot }
    try await waitUntil { model.historyView != nil }
    XCTAssertEqual(model.displayState.messages.map(\.text), ["received committed user"])
    XCTAssertEqual(model.state.messages, [local], "passive display leaves native chat state intact")
    XCTAssertFalse(
      model.historyView?.usable ?? true, "display does not wait for assessment or a model answer")
    model.draft = "ordinary local input while the successor is incomplete"
    model.send()
    try await waitUntil { socket.sent.count == 1 }
    XCTAssertTrue(remote.continued.isEmpty)
    XCTAssertEqual(
      socket.sent.first?.text, "ordinary local input while the successor is incomplete")
    remote.finishAssessment(false)
    model.disconnect()
  }

  func testSequentialHandoffRespectsDraftPickerAndRunningLocalWork() async throws {
    for protection in ["draft", "picker", "running", "sending", "sibling"] {
      let remote = FakeNativeHistory()
      let socket = FakeConversation()
      let model = ConversationViewModel(
        conversation: socket,
        outbox: OutboxStore(directory: outboxDirectory.appendingPathComponent(UUID().uuidString)),
        history: remote)
      model.select(botId: "b_1")
      socket.emit(.connection(.ready))
      let local = Message(
        id: "local-tail", role: .assistant, state: .complete,
        createdAt: "x", blocks: [.text("local answer")])
      socket.emit(
        .snapshot(
          ConversationSnapshot(botId: "b_1", messages: [local], running: protection == "running")))
      try await waitUntil { model.hasSnapshot }
      if protection == "draft" { model.draft = "keep my draft" }
      if protection == "picker" { await model.selectHistory(nil) }
      if protection == "sending" {
        model.draft = "local work awaiting admission"
        model.send()
        try await waitUntil { socket.sent.count == 1 }
      }
      remote.extendsCurrent = protection != "sibling"
      await model.refreshHistory()
      XCTAssertNil(model.historyView, protection)
      XCTAssertEqual(
        model.displayState.messages.last?.text,
        protection == "sending" ? "local work awaiting admission" : "local answer")
      model.disconnect()
    }
  }

  func testAnUnsettledSendProtectsItsBotWithoutBlockingHandoffAfterSwitchingBots() async throws {
    let remote = FakeNativeHistory()
    remote.assessedUsable = false
    let socket = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = ConversationViewModel(conversation: socket, outbox: outbox, history: remote)
    defer { model.disconnect() }
    let local = Message(
      id: "local-tail", role: .assistant, state: .complete,
      createdAt: "x", blocks: [.text("completed local answer")])
    model.select(botId: "X")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "X", messages: [local])))
    try await waitUntil { model.hasSnapshot }
    model.draft = "unsettled X request"
    model.send()
    try await waitUntil { socket.sent.count == 1 && !model.isSending }
    let original = try XCTUnwrap(socket.sent.first)
    let oldEvents = try XCTUnwrap(socket.continuation)
    XCTAssertEqual(original.botId, "X")
    XCTAssertEqual(try outbox.entries(for: "X").map(\.requestId), [original.requestId])

    model.select(botId: "Y")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "Y", messages: [local])))
    try await waitUntil { model.hasSnapshot }
    // X's old subscription cannot settle the request after its consumer was canceled.
    oldEvents.yield(
      .submission(Submission(id: "s_X", requestId: original.requestId, status: .done)))
    remote.extendsCurrent = true
    await model.refreshHistory()
    XCTAssertEqual(
      model.displayState.messages.map(\.text), ["received committed user"],
      "an unresolved request on X cannot hide Y's proven successor")
    XCTAssertEqual(model.state.messages, [local])
    XCTAssertEqual(try outbox.entries(for: "X").map(\.requestId), [original.requestId])

    model.draft = "unsettled Y request"
    model.send()
    try await waitUntil { socket.sent.count == 2 && !model.isSending }
    let yRequest = try XCTUnwrap(socket.sent.last)
    XCTAssertEqual(yRequest.botId, "Y")
    await model.refreshHistory()
    XCTAssertNil(model.historyView, "Y's own unsettled send still protects its local context")
    XCTAssertTrue(remote.continued.isEmpty)

    model.select(botId: "X")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "X", messages: [local])))
    try await waitUntil { socket.sent.count == 3 && !model.isSending }
    XCTAssertEqual(socket.sent.last?.botId, "X")
    XCTAssertEqual(socket.sent.last?.requestId, original.requestId)
    XCTAssertEqual(socket.sent.last?.text, "unsettled X request")
    await model.refreshHistory()
    XCTAssertNil(model.historyView, "returning to X restores its unresolved request protection")
    XCTAssertEqual(try outbox.entries(for: "X").map(\.requestId), [original.requestId])
    socket.emit(.submission(Submission(id: "s_X", requestId: original.requestId, status: .done)))
    try await waitUntil { (try? outbox.entries(for: "X").isEmpty) == true }
    await model.refreshHistory()
    XCTAssertEqual(
      model.displayState.messages.map(\.text), ["received committed user"],
      "Y's unresolved send must not block X after X settles")
    XCTAssertEqual(try outbox.entries(for: "Y").map(\.requestId), [yRequest.requestId])
  }

  func testALateSequentialViewCannotOverrideANewDraftOrLocalSend() async throws {
    for intent in ["draft", "send", "picker"] {
      let remote = FakeNativeHistory()
      remote.extendsCurrent = true
      remote.blockView = true
      let socket = FakeConversation()
      let model = ConversationViewModel(
        conversation: socket,
        outbox: OutboxStore(directory: outboxDirectory.appendingPathComponent(UUID().uuidString)),
        history: remote)
      model.select(botId: "b_1")
      socket.emit(.connection(.ready))
      let local = Message(
        id: "local-tail", role: .assistant, state: .complete,
        createdAt: "x", blocks: [.text("local answer")])
      socket.emit(.snapshot(ConversationSnapshot(botId: "b_1", messages: [local])))
      try await waitUntil { model.hasSnapshot }
      try await waitUntil { remote.viewContinuation != nil }
      if intent == "picker" {
        await model.selectHistory(nil)
      } else {
        model.draft = "new local intent"
        if intent == "send" { model.send() }
      }
      remote.blockView = false
      remote.viewContinuation?.resume()
      remote.viewContinuation = nil
      for _ in 0..<20 { await Task.yield() }
      XCTAssertNil(model.historyView, intent)
      if intent == "send" { try await waitUntil { socket.sent.count == 1 } }
      model.disconnect()
    }
  }

  func testAutomaticSuccessorsUseTheDisplayedImmutableHeadAndDoNotJumpToItsSibling() async throws {
    let remote = FakeNativeHistory()
    let socket = FakeConversation()
    let model = ConversationViewModel(
      conversation: socket, outbox: OutboxStore(directory: outboxDirectory), history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.historyView?.usable == true }
    let firstHead = model.historyView?.head
    remote.secondBranch = true
    remote.extendsCurrent = true
    await model.refreshHistory()
    XCTAssertEqual(model.historyView?.branchId, "second-branch")
    XCTAssertEqual(remote.afterHeads.last ?? nil, firstHead)
    remote.extendsCurrent = false
    await model.refreshHistory()
    XCTAssertEqual(
      model.historyView?.branchId, "second-branch",
      "same conversation siblings need actual ancestry")
    model.disconnect()
  }

  func testEmptyAutomaticReceivedHistoryDoesNotBlockTheFirstNativeSend() async throws {
    let remote = FakeNativeHistory()
    remote.emptyFirstBranch = true
    remote.assessedUsable = false
    let socket = FakeConversation()
    let model = ConversationViewModel(
      conversation: socket, outbox: OutboxStore(directory: outboxDirectory), history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { !remote.viewed.isEmpty }
    await model.refreshHistory()
    model.draft = "first native local question"
    model.send()
    try await waitUntil { socket.sent.count == 1 }
    XCTAssertEqual(socket.sent.first?.text, "first native local question")
    XCTAssertTrue(remote.continued.isEmpty)
    XCTAssertNil(model.historyView)
    XCTAssertEqual(remote.assessments, 0, "empty automatic candidates need no full assessment")
    await model.selectHistory("remote-branch")
    model.draft = "an explicit empty branch still cannot continue"
    model.send()
    await Task.yield()
    XCTAssertEqual(socket.sent.count, 1)
    XCTAssertTrue(remote.continued.isEmpty)
    XCTAssertEqual(model.draft, "an explicit empty branch still cannot continue")
    model.disconnect()
  }

  func testAnAutomaticViewReadKeepsNativeSendAvailableAndCannotReplaceItsLocalIntent() async throws
  {
    let remote = FakeNativeHistory()
    remote.blockView = true
    let socket = FakeConversation()
    let model = ConversationViewModel(
      conversation: socket, outbox: OutboxStore(directory: outboxDirectory), history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { remote.viewContinuation != nil }
    model.draft = "local send while the automatic read is held"
    model.send()
    try await waitUntil { socket.sent.count == 1 }
    remote.blockView = false
    remote.viewContinuation?.resume()
    remote.viewContinuation = nil
    await model.refreshHistory()
    XCTAssertEqual(socket.sent.first?.text, "local send while the automatic read is held")
    XCTAssertNil(model.historyView, "the late nonempty view cannot take over local chat")
    XCTAssertTrue(remote.continued.isEmpty)
    model.disconnect()
  }

  func testAnAutomaticViewCannotOverrideAnExplicitLocalPickerChoice() async throws {
    let remote = FakeNativeHistory()
    remote.blockView = true
    let socket = FakeConversation()
    let model = ConversationViewModel(
      conversation: socket, outbox: OutboxStore(directory: outboxDirectory), history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { remote.viewContinuation != nil }
    await model.selectHistory(nil)
    remote.blockView = false
    remote.viewContinuation?.resume()
    remote.viewContinuation = nil
    await model.refreshHistory()
    model.draft = "local picker stays selected"
    model.send()
    try await waitUntil { socket.sent.count == 1 }
    XCTAssertEqual(socket.sent.first?.text, "local picker stays selected")
    XCTAssertNil(model.historyView)
    XCTAssertTrue(remote.continued.isEmpty)
    model.disconnect()
  }

  func testAnEmptyFirstBranchDoesNotHideLaterPartialMessages() async throws {
    let remote = FakeNativeHistory()
    remote.emptyFirstBranch = true
    remote.secondBranch = true
    remote.blockAssessment = true
    let socket = FakeConversation()
    let model = ConversationViewModel(
      conversation: socket, outbox: OutboxStore(directory: outboxDirectory), history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.historyView?.branchId == "second-branch" }
    XCTAssertEqual(model.displayState.messages.map(\.text), ["received committed user"])
    XCTAssertTrue(model.state.messages.isEmpty)
    XCTAssertFalse(model.historyView?.usable ?? true)
    remote.finishAssessment(false)
    model.disconnect()
  }

  func testPassiveUserDisplaysBeforeAssessmentWithoutChangingLocalState() async throws {
    let remote = FakeNativeHistory()
    let socket = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = ConversationViewModel(conversation: socket, outbox: outbox, history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.hasSnapshot }
    remote.blockAssessment = true
    await model.refreshHistory()
    XCTAssertEqual(model.displayState.messages.map(\.text), ["received committed user"])
    XCTAssertTrue(model.state.messages.isEmpty)
    XCTAssertFalse(model.historyView?.usable ?? true)
    XCTAssertTrue(remote.continued.isEmpty)
    model.draft = "ordinary local input while the passive head is incomplete"
    model.send()
    try await waitUntil { socket.sent.count == 1 }
    XCTAssertEqual(
      socket.sent.first?.text, "ordinary local input while the passive head is incomplete")
    XCTAssertTrue(remote.continued.isEmpty)
    remote.finishAssessment(false)
    model.disconnect()
  }

  func testLiveContextRemainsUntilExplicitBranchContinueAndNextSendUsesLocalChat() async throws {
    let remote = FakeNativeHistory()
    remote.blockContinuation = true
    let socket = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = ConversationViewModel(conversation: socket, outbox: outbox, history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    let local = Message(
      id: "local", role: .user, state: .complete, createdAt: "x", blocks: [.text("local context")])
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1", messages: [local])))
    try await waitUntil { model.hasSnapshot }
    await model.refreshHistory()
    XCTAssertEqual(model.displayState.messages, [local])
    await model.selectHistory("remote-branch")
    try await waitUntil { model.historyView?.usable == true }
    XCTAssertEqual(model.displayState.messages.map(\.text), ["received committed user"])
    XCTAssertEqual(model.state.messages, [local])
    model.draft = "explicit local continuation"
    model.send()
    try await waitUntil { remote.continued.count == 1 }
    model.draft = "next prompt"
    model.send()
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertTrue(socket.sent.isEmpty, "ordinary send cannot race ahead of continuation admission")
    remote.finishContinuation()
    try await waitUntil { !model.isSending }
    XCTAssertNil(model.historyView)
    XCTAssertEqual(model.localBranchId, "new-local-branch")
    model.draft = "next prompt"
    model.send()
    try await waitUntil { socket.sent.count == 1 }
    XCTAssertEqual(socket.sent.first?.text, "next prompt")
    XCTAssertTrue(
      try outbox.entries(for: "b_1").allSatisfy { $0.text != "explicit local continuation" })
    model.disconnect()
  }

  func testUncertainContinuationReopenKeepsHeadAndRequestInsteadOfOrdinarySend() async throws {
    let remote = FakeNativeHistory()
    remote.failContinuation = true
    let firstSocket = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let first = ConversationViewModel(conversation: firstSocket, outbox: outbox, history: remote)
    first.select(botId: "b_1")
    firstSocket.emit(.connection(.ready))
    firstSocket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { first.historyView?.usable == true }
    first.draft = "keep the continuation identity"
    first.send()
    try await waitUntil { remote.continued.count == 1 && !first.isSending }
    let stored = try XCTUnwrap(outbox.entries(for: "b_1").first)
    XCTAssertEqual(stored.historyHead, remote.continued[0].head)
    first.draft = "must wait for unknown admission"
    XCTAssertFalse(first.canSend)
    first.send()
    await Task.yield()
    XCTAssertTrue(firstSocket.sent.isEmpty, "an unknown HTTP result does not release admission")
    XCTAssertEqual(first.draft, "must wait for unknown admission")
    first.disconnect()
    remote.failContinuation = false
    let socket = FakeConversation()
    let reopened = ConversationViewModel(
      conversation: socket, outbox: OutboxStore(directory: outboxDirectory), history: remote)
    reopened.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { remote.continued.count == 2 && !reopened.isSending }
    XCTAssertEqual(remote.continued[1].head, stored.historyHead)
    XCTAssertEqual(remote.continued[1].requestId, stored.requestId)
    XCTAssertTrue(socket.sent.isEmpty)
    XCTAssertTrue(try outbox.entries(for: "b_1").isEmpty)
    reopened.disconnect()
  }

  func testChangingTheDisplayedBranchCannotSendThePreviouslyLoadedHead() async throws {
    let remote = FakeNativeHistory()
    let socket = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = ConversationViewModel(conversation: socket, outbox: outbox, history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.historyView?.usable == true }
    remote.secondBranch = true
    await model.refreshHistory()
    remote.blockView = true
    let changing = Task { await model.selectHistory("second-branch") }
    try await waitUntil { remote.viewContinuation != nil }
    model.draft = "only send to the chosen branch"
    XCTAssertFalse(model.canSend)
    model.send()
    await Task.yield()
    XCTAssertTrue(remote.continued.isEmpty, "the old A view must not admit Send intended for B")
    XCTAssertTrue(socket.sent.isEmpty)
    XCTAssertEqual(model.draft, "only send to the chosen branch")
    remote.viewContinuation?.resume()
    remote.viewContinuation = nil
    await changing.value
    try await waitUntil { model.historyView?.usable == true }
    model.send()
    try await waitUntil { remote.continued.count >= 1 && !model.isSending }
    XCTAssertEqual(remote.continued.last?.head, String(repeating: "b", count: 64))
    model.disconnect()
  }

  func testReopenedAdmittedContinuationAllowsSteerWhileProviderStillRuns() async throws {
    let remote = FakeNativeHistory()
    remote.blockContinuation = true
    let socket = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    try outbox.add(
      OutboxEntry(
        botId: "b_1", requestId: "r_admitted", text: "original continuation",
        historyHead: String(repeating: "a", count: 64)))
    let model = ConversationViewModel(conversation: socket, outbox: outbox, history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(
      .snapshot(
        ConversationSnapshot(
          botId: "b_1", pending: [Submission(id: "s_1", requestId: "r_admitted", status: .placed)],
          running: true)))
    try await waitUntil { remote.continuation != nil }
    model.draft = "steer the already admitted local provider"
    model.send(inserting: true)
    try await waitUntil { socket.sent.count == 1 }
    XCTAssertEqual(socket.sent.first?.text, "steer the already admitted local provider")
    XCTAssertEqual(socket.busyModes, [.steer])
    XCTAssertEqual(remote.continued.count, 1, "outbox retry still retains its original identity")
    remote.finishContinuation()
    try await waitUntil { !model.isSending }
    model.disconnect()
  }

  func testDefiniteContinuationRejectionRestoresDraftAndNeverReplaysOnReopen() async throws {
    let remote = FakeNativeHistory()
    remote.continuationError = ClientError(
      "invalid history continuation", disposition: .notAdmitted)
    let socket = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = ConversationViewModel(conversation: socket, outbox: outbox, history: remote)
    model.select(botId: "b_1")
    socket.emit(.connection(.ready))
    socket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.historyView?.usable == true }
    let invalid = String(repeating: "x", count: 8001)
    model.draft = invalid
    model.send()
    try await waitUntil { remote.continued.count == 1 && !model.isSending }
    XCTAssertEqual(model.draft, invalid)
    XCTAssertTrue(try outbox.entries(for: "b_1").isEmpty)
    model.disconnect()
    let nextSocket = FakeConversation()
    let reopened = ConversationViewModel(conversation: nextSocket, outbox: outbox, history: remote)
    reopened.select(botId: "b_1")
    nextSocket.emit(.connection(.ready))
    nextSocket.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { reopened.hasSnapshot }
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(remote.continued.count, 1, "deterministic refusal cannot replay after reopen")
    reopened.disconnect()
  }

  func testAnAgentUpdatePreservesLoadedHistoryAndUnconfirmedSends() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1", running: true, parked: true)))
    try await waitUntil { model.hasSnapshot }
    let older = Message(
      id: "e_1", role: .user, state: .complete, createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [.text("已经加载的旧消息")])
    fake.emit(.history(page: HistoryPage(messages: [older], hasMore: true)))
    try await waitUntil { model.state.messages.count == 1 }
    model.draft = "尚未确认的新消息"
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    let before = model.state
    let pending = try outbox.entries(for: "b_1").map(\.requestId)
    XCTAssertEqual(before.messages.count, 2)
    XCTAssertTrue(before.messages.last?.isOptimistic == true)
    let agent = AgentView(
      model: ModelRef(provider: "faux", modelId: "faux-1"),
      thinkingLevel: "high", instructions: "Keep the conversation intact.")
    fake.emit(.agent(agent))
    try await waitUntil { model.state.agent == agent }

    var expected = before
    expected.agent = agent
    XCTAssertEqual(model.state, expected)
    XCTAssertTrue(model.hasOlder)
    XCTAssertTrue(model.parked)
    XCTAssertEqual(try outbox.entries(for: "b_1").map(\.requestId), pending)
  }

  func testInsertingSendsASteerAndAPlainSendQueues() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(for: .milliseconds(30))

    model.draft = "先排队"
    model.send()
    model.draft = "改方向"
    model.send(inserting: true)
    try await Task.sleep(for: .milliseconds(60))

    XCTAssertEqual(fake.busyModes, [.followUp, .steer])
  }

  func testSnapshotReadinessResetsAcrossReconnectSelectionAndDisconnect() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1", running: true)))
    try await waitUntil { model.hasSnapshot }

    fake.emit(.connection(.reconnecting(attempt: 1)))
    try await waitUntil { model.connection == .reconnecting(attempt: 1) }
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.hasSnapshot }

    model.select(botId: "b_2")
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_2")))
    try await waitUntil { model.hasSnapshot }
    model.disconnect()
    XCTAssertFalse(model.hasSnapshot)
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
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 1, "the outbox is stored before the frame")
    let requestId = try XCTUnwrap(try outbox.entries(for: "b_1").first?.requestId)
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
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 0, "a terminal record removes the entry")
  }

  func testNotAdmittedRemovesTheBubbleAndTheOutboxEntry() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    model.draft = "太长"
    model.send()
    let requestId = try XCTUnwrap(try outbox.entries(for: "b_1").first?.requestId)

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
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 0, "a refusal clears the entry")
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
    let requestId = try XCTUnwrap(try outbox.entries(for: "b_1").first?.requestId)

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
      try outbox.entries(for: "b_1").count,
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

@MainActor private final class FakeNativeHistory: NativeHistoryPort {
  var secondBranch = false
  var extendsCurrent = false
  var afterHeads: [String?] = []
  var emptyFirstBranch = false
  var viewed: [String] = []
  var assessments = 0
  var assessedUsable = true
  var blockView = false
  var viewContinuation: CheckedContinuation<Void, Never>?
  var continuationError: Error?
  var blockAssessment = false
  var assessment: CheckedContinuation<Bool, Never>?
  var continued: [(head: String, text: String, requestId: String)] = []
  var failContinuation = false
  var blockContinuation = false
  var continuation: CheckedContinuation<Void, Never>?
  func finishContinuation() {
    continuation?.resume()
    continuation = nil
  }
  func branches(botId: String) async throws -> [NativeHistoryBranch] {
    var result = [
      NativeHistoryBranch(
        branchId: "remote-branch", conversationId: "remote-conversation",
        selection: String(repeating: "a", count: 64))
    ]
    if secondBranch {
      result.append(
        NativeHistoryBranch(
          branchId: "second-branch", conversationId: "other",
          selection: String(repeating: "b", count: 64)))
    }
    return result
  }
  func view(botId: String, head: String, after: String?) async throws -> NativeHistoryView {
    viewed.append(head)
    afterHeads.append(after)
    if blockView { await withCheckedContinuation { viewContinuation = $0 } }
    return NativeHistoryView(
      head: head,
      branchId: head == String(repeating: "b", count: 64) ? "second-branch" : "remote-branch",
      usable: false,
      messages: emptyFirstBranch && head == String(repeating: "a", count: 64)
        ? []
        : [
          Message(
            id: "remote", role: .user, state: .complete, createdAt: "x",
            blocks: [.text("received committed user")])
        ],
      extendsCurrent: extendsCurrent)
  }
  func assess(botId: String, head: String) async throws -> Bool {
    assessments += 1
    if blockAssessment { return await withCheckedContinuation { assessment = $0 } }
    return assessedUsable
  }
  func finishAssessment(_ usable: Bool) {
    assessment?.resume(returning: usable)
    assessment = nil
  }
  func continueHistory(botId: String, head: String, text: String, requestId: String) async throws
    -> NativeHistoryContinuation
  {
    continued.append((head, text, requestId))
    if let continuationError { throw continuationError }
    if failContinuation { throw ClientError("response lost after possible admission") }
    if blockContinuation { await withCheckedContinuation { continuation = $0 } }
    return NativeHistoryContinuation(
      branchId: "new-local-branch",
      submission: Submission(id: "submission", requestId: requestId, status: .done))
  }
}

final class FakeConversation: ConversationPort {
  struct Sent {
    let text: String
    let requestId: String
    let botId: String
  }

  var sent: [Sent] = []
  var lastBotId: String?
  var recovered = 0
  var failRecover = false
  var aborted = 0
  var historyRequests: [String] = []
  private(set) var continuation: AsyncStream<ConversationEvent>.Continuation?

  var busyModes: [BusyMode] = []

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
    sent.append(Sent(text: text, requestId: context.requestId ?? "", botId: botId))
    busyModes.append(whenBusy)
    lastBotId = botId
  }

  func abort(context: CommandContext, botId: String) async throws {
    aborted += 1
    lastBotId = botId
  }

  func recover(context: CommandContext, botId: String) async throws {
    if failRecover { throw ClientError("there is no connection") }
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

  func testTasksFollowTheSelectedBotAndAreClearedByASelection() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(
      .snapshot(
        ConversationSnapshot(
          botId: "b_1",
          tasks: [TaskSummary(id: "t_1", kind: "pi.generation", status: .running)]
        ))
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(model.tasks.map(\.id), ["t_1"])

    fake.emit(.tasks([TaskSummary(id: "t_2", kind: "pi.tool", status: .waiting)]))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(model.tasks.map(\.id), ["t_2"], "the event replaces the list")

    model.select(botId: "b_2")
    XCTAssertEqual(model.tasks, [], "another bot starts without the previous bot's tasks")
  }

  func testACatalogEventIsForwardedAndAnErrorCanBeDismissed() async throws {
    let (model, fake) = make()
    var forwarded: BotCatalog?
    model.onCatalog = { forwarded = $0 }
    model.select(botId: "b_1")
    fake.emit(
      .catalog(
        BotCatalog(
          bots: [
            BotSummary(
              id: "b_1",
              title: "一",
              createdAt: "x",
              updatedAt: "x",
              model: ModelRef(provider: "p", modelId: "m"),
              state: .idle
            )
          ]
        ))
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
    XCTAssertEqual(forwarded?.bots.map(\.id), ["b_1"])
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

  func testASettledRecordIsRestoredWhenTheBotIsSelected() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-settled-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = OutboxStore(directory: directory)
    try outbox.add(OutboxEntry(botId: "b_1", requestId: "r_settled", text: "问"))
    try outbox.settle(
      Submission(id: "s_1", requestId: "r_settled", status: .unanswered, reason: "aborted"),
      botId: "b_1"
    )
    let fake = FakeConversation()
    let model = ConversationViewModel(botId: "", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    try await Task.sleep(nanoseconds: 30_000_000)
    XCTAssertEqual(model.state.ranks["s_1"]?.status, .unanswered)
    XCTAssertEqual(model.state.ranks["s_1"]?.reason, "aborted")
    XCTAssertTrue(model.state.pending.isEmpty)
  }

  func testARefusedRequestIsNotReplayedWhenItsEntryCannotBeRemoved() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-refused-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.setAttributes(
        [.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: directory)
    }
    let fake = FakeConversation()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(botId: "b_1", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 40_000_000)
    model.draft = "A"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    let sendsBefore = fake.sent.count

    // The refusal cannot be removed because the directory refuses the atomic write.
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
    fake.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 60_000_000)
    XCTAssertNotNil(
      model.errorBanner,
      "a refusal whose entry could not be removed is reported, not swallowed"
    )
    // A reconnect reconciles the outbox; the refused request must not be re-sent.
    fake.emit(.connection(.reconnecting(attempt: 1)))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 80_000_000)
    XCTAssertEqual(fake.sent.count, sendsBefore, "a refused request is never replayed")

    // The refusal is durable even while the support directory is unwritable: the
    // tombstone falls back to a user-private temporary directory, so a new process that
    // starts from the same file still does not replay it.
    XCTAssertTrue(
      try OutboxStore(directory: directory).refusedRequests().contains(requestId),
      "the refusal survives a restart"
    )
    let restarted = FakeConversation()
    let reopened = OutboxStore(directory: directory)
    let next = ConversationViewModel(botId: "b_1", conversation: restarted, outbox: reopened)
    next.select(botId: "b_1")
    restarted.emit(.connection(.ready))
    restarted.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 80_000_000)
    XCTAssertEqual(restarted.sent.count, 0, "a restarted client never replays a refused request")
  }

  func testAFailedRecoverKeepsTheParkedAffordance() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(
      .error(
        kind: .taskParked,
        disposition: .runtime,
        message: "a task was parked",
        failure: "f_parked",
        requestId: nil
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.parked)
    fake.failRecover = true
    model.recover()
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.parked, "a recover that never reached the daemon leaves the entry")
    XCTAssertNotNil(model.errorBanner)
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

@MainActor
final class SettledRankTests: XCTestCase {
  func testARestoredSettlementKeepsItsSubmissionId() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-settled-key-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = OutboxStore(directory: directory)
    try outbox.add(OutboxEntry(botId: "b_1", requestId: "r_saved", text: "问"))
    try outbox.settle(
      Submission(
        id: "s_saved",
        requestId: "r_saved",
        status: .done,
        entryId: "e_7",
        answerEntryId: "e_10"
      ),
      botId: "b_1"
    )
    let fake = FakeConversation()
    let model = ConversationViewModel(botId: "", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(
      model.state.ranks["s_saved"]?.status,
      .done,
      "the rank is keyed by the submission id, not the request id"
    )
    XCTAssertNil(model.state.ranks["r_saved"], "a request id is not a rank key")
  }
}
