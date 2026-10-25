import BotsCore
import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Bots presentation")
struct BotsPresenterTests {
  private let presenter = BotsPresenter()

  private func message(
    _ id: String,
    role: MessageRole,
    state: MessageState = .complete,
    text: String
  ) -> Message {
    Message(
      id: id,
      role: role,
      state: state,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [.text(text)]
    )
  }

  @Test("a transcript maps user, assistant and notice rows")
  func transcript() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(message: message("e_7", role: .user, text: "问题"), replaces: nil),
      to: state
    )
    state = Reducer.apply(
      .append(message: message("e_10", role: .assistant, text: "回答"), replaces: nil),
      to: state
    )
    state = Reducer.apply(
      .append(
        message: message("e_11", role: .notice, text: "回答超出传输上限"),
        replaces: nil
      ),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(entries.count == 3)
    #expect(
      {
        if case .user(_, "问题") = entries[0] { return true } else { return false }
      }())
    #expect(
      {
        if case .assistant(_, [.paragraph("回答")]) = entries[1] { return true } else { return false }
      }())
    #expect(
      {
        if case .assistant(_, [.note("回答超出传输上限")]) = entries[2] {
          return true
        } else {
          return false
        }
      }())
  }

  @Test("streaming text grows in place and an empty attempt shows typing")
  func streaming() {
    var state = ConversationState(botId: "b_1", running: true)
    state = Reducer.apply(
      .append(
        message: message("p_a1", role: .assistant, state: .streaming, text: ""),
        replaces: nil
      ),
      to: state
    )
    #expect(
      presenter.transcript(for: state).contains { if case .typing = $0 { true } else { false } })

    state = Reducer.apply(
      .delta(messageId: "p_a1", changes: [.text(index: 0, append: "巴黎")]),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(
      entries.contains { if case .assistant(_, [.paragraph("巴黎")]) = $0 { true } else { false } })
    #expect(!entries.contains { if case .typing = $0 { true } else { false } })
  }

  @Test("an unavailable bot says so and a sidebar item carries its state")
  func unavailable() {
    let state = ConversationState(
      botId: "b_1",
      unavailable: BotUnavailable(reason: .storageFailed, message: "session closed")
    )
    let entries = presenter.transcript(for: state)
    #expect(entries.count == 1)
    #expect(noteText(entries[0])?.contains("不可用") == true)

    let bot = BotSummary(
      id: "b_1",
      title: "研究员",
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .running
    )
    let item = presenter.sidebarItem(for: bot)
    #expect(item.title == "研究员")
    #expect(item.tag == "回答中")
    #expect((0..<Theme.Palette.avatarTints.count).contains(item.tintIndex))
  }

  private func noteText(_ entry: TranscriptEntry?) -> String? {
    guard case .assistant(_, let blocks) = entry else { return nil }
    for block in blocks {
      if case .note(let text) = block { return text }
    }
    return nil
  }

  @Test("thinking and tool results stay out of the answer bubble")
  func hiddenBlocks() {
    var state = ConversationState(botId: "b_1")
    let message = Message(
      id: "e_10",
      role: .assistant,
      state: .complete,
      createdAt: "x",
      blocks: [
        .thinking("内心独白"),
        .text("可见"),
        .toolCall(callId: "c_1", name: "search", args: ["q": .string("paris")]),
        .toolResult(
          callId: "c_1", name: "search", text: "工具结果", isError: false, durationMs: nil),
      ],
      stopReason: .length
    )
    state = Reducer.apply(.append(message: message, replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    // The answer is its own bubble: no thinking, no call, no result text inside it.
    #expect(
      {
        if case .assistant(_, let blocks) = entries.first {
          return blocks == [.paragraph("可见")]
        }
        return false
      }())
    // The call is a row of its own, and the length note follows as a separate row.
    #expect(
      entries.contains {
        if case .tool(_, let row) = $0 { row.name == "search" } else { false }
      })
    #expect(
      entries.contains {
        if case .assistant(_, [.note("回答因为长度上限被截断。")]) = $0 { true } else { false }
      })
  }

  @Test("an aborted answer says it was aborted")
  func aborted() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: message("e_10", role: .assistant, state: .aborted, text: "一半"),
        replaces: nil
      ),
      to: state
    )
    let entry = presenter.transcript(for: state).first
    #expect(
      {
        if case .assistant(_, [.paragraph("一半"), .note("回答已中止")]) = entry { return true }
        return false
      }())
  }
}

@Suite("Bot faces")
struct BotFaceTests {
  private let presenter = BotsPresenter()

  @Test("the sidebar item carries the chosen face and the optional label")
  func faceAndLabel() {
    let bot = BotSummary(
      id: "b_1",
      title: "研究员",
      label: "研究",
      appearance: BotAppearance(shape: .star, tint: .violet),
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .idle
    )
    let item = presenter.sidebarItem(for: bot)
    #expect(item.tag == "研究")
    #expect(item.face?.shape == .star)
    #expect(item.face?.tint == .violet)
  }

  @Test("a bot written before appearance draws the default face")
  func defaultFace() {
    let bot = BotSummary(
      id: "b_1",
      title: "旧的",
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .idle
    )
    #expect(bot.face == .standard)
    let item = presenter.sidebarItem(for: bot)
    #expect(item.face?.shape == .blob)
    #expect(item.face?.tint == .green)
  }
}

@Suite("Bots tool rows")
struct BotsToolRowTests {
  private let presenter = BotsPresenter()

  private func message(
    _ id: String,
    role: MessageRole,
    state: MessageState = .complete,
    blocks: [ContentBlock]
  ) -> Message {
    Message(id: id, role: role, state: state, createdAt: "2026-01-01T00:00:00.000Z", blocks: blocks)
  }

  private func call(_ callId: String = "c_1") -> Message {
    message(
      "e_10",
      role: .assistant,
      blocks: [
        .text("我先看一下。"),
        .toolCall(
          callId: callId,
          name: "read_file",
          args: ["path": .string("notes.txt"), "limit": .number(50)]
        ),
      ]
    )
  }

  private func result(
    _ callId: String = "c_1",
    isError: Bool = false,
    durationMs: Int? = 21
  ) -> Message {
    message(
      "e_11",
      role: .tool,
      blocks: [
        .toolResult(
          callId: callId,
          name: "read_file",
          text: "工作区里的内容",
          isError: isError,
          durationMs: durationMs
        )
      ]
    )
  }

  private func toolRows(_ entries: [TranscriptEntry]) -> [ToolRow] {
    entries.compactMap {
      if case .tool(_, let row) = $0 { return row }
      return nil
    }
  }

  @Test("a call without its result is a running row while the run works")
  func runningRow() {
    var state = ConversationState(botId: "b_1", running: true)
    state = Reducer.apply(.append(message: call(), replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.count == 1)
    #expect(rows.first?.name == "read_file")
    #expect(rows.first?.subtitle == "path=notes.txt · limit=50")
    #expect(rows.first?.isRunning == true)
    #expect(rows.first?.output == nil)
    #expect(rows.first?.input.contains("\"path\": \"notes.txt\"") == true)
    // The tool row replaces the typing row: the model is not silent, it is running a tool.
    #expect(!entries.contains { if case .typing = $0 { true } else { false } })
  }

  @Test("the result pairs with its call by id, live and after a snapshot")
  func pairedResult() {
    var state = ConversationState(botId: "b_1", running: false)
    state = Reducer.apply(.append(message: call(), replaces: nil), to: state)
    state = Reducer.apply(.append(message: result(), replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.count == 1, "the result message is consumed by the call row")
    #expect(rows.first?.isRunning == false)
    #expect(rows.first?.output == "工作区里的内容")
    #expect(rows.first?.duration == "21 ms")
    #expect(rows.first?.isError == false)
    // The answer text on the same message keeps its own bubble, in order.
    #expect(
      entries.contains {
        if case .assistant(_, [.paragraph("我先看一下。")]) = $0 { true } else { false }
      })
  }

  @Test("a failed tool colors the row and shows its error text")
  func failedRow() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(.append(message: call(), replaces: nil), to: state)
    state = Reducer.apply(
      .append(message: result(isError: true, durationMs: nil), replaces: nil),
      to: state
    )
    let rows = toolRows(presenter.transcript(for: state))
    #expect(rows.first?.isError == true)
    #expect(rows.first?.output == "工作区里的内容")
    #expect(rows.first?.duration == nil)
  }

  @Test("a result whose call left the page is still shown")
  func standaloneResult() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(.append(message: result("c_9"), replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.count == 1)
    #expect(rows.first?.name == "read_file")
    #expect(rows.first?.output == "工作区里的内容")
    #expect(rows.first?.isRunning == false)
  }

  @Test("a plain answer is still one bubble with the message id")
  func plainAnswerUnchanged() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: message("e_13", role: .assistant, blocks: [.text("回答")]),
        replaces: nil
      ),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(entries.count == 1)
    if case .assistant(let id, let blocks) = entries[0] {
      #expect(id == "e_13")
      #expect(blocks == [.paragraph("回答")])
    } else {
      Issue.record("a plain answer must stay an assistant bubble")
    }
  }

  @Test("a run with only an aborted tool call still says the answer was aborted")
  func abortedToolRun() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: message(
          "p_a1",
          role: .assistant,
          state: .aborted,
          blocks: [
            .toolCall(callId: "c_1", name: "run_command", args: ["command": .string("make")])
          ]
        ),
        replaces: nil
      ),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(toolRows(entries).count == 1)
    #expect(
      entries.contains { if case .assistant(_, [.note("回答已中止")]) = $0 { true } else { false } }
    )
  }
}

@Suite("Bots tool row pairing")
struct BotsToolPairingTests {
  private let presenter = BotsPresenter()

  private func message(_ id: String, role: MessageRole, blocks: [ContentBlock]) -> Message {
    Message(
      id: id,
      role: role,
      state: .complete,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: blocks
    )
  }

  private func toolRows(_ entries: [TranscriptEntry]) -> [ToolRow] {
    entries.compactMap {
      if case .tool(_, let row) = $0 { return row }
      return nil
    }
  }

  private func toolIds(_ entries: [TranscriptEntry]) -> [String] {
    entries.compactMap {
      if case .tool(let id, _) = $0 { return id }
      return nil
    }
  }

  @Test("two rounds that reuse a call id keep their own results and unique row ids")
  func duplicateCallIds() {
    var state = ConversationState(botId: "b_1")
    for round in 1...2 {
      state = Reducer.apply(
        .append(
          message: message(
            "e_\(round * 10)",
            role: .assistant,
            blocks: [
              .toolCall(callId: "c_1", name: "read_file", args: ["path": .string("\(round)")])
            ]
          ),
          replaces: nil
        ),
        to: state
      )
      state = Reducer.apply(
        .append(
          message: message(
            "e_\(round * 10 + 1)",
            role: .tool,
            blocks: [
              .toolResult(
                callId: "c_1", name: "read_file", text: "round \(round)", isError: false,
                durationMs: nil)
            ]
          ),
          replaces: nil
        ),
        to: state
      )
    }
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.map(\.output) == ["round 1", "round 2"])
    #expect(Set(toolIds(entries)).count == 2, "ForEach ids are unique")
  }

  @Test("an old call without a result does not run again when a new run starts")
  func staleCallDoesNotRevive() {
    var state = ConversationState(botId: "b_1", running: true)
    state = Reducer.apply(
      .append(
        message: message(
          "e_10",
          role: .assistant,
          blocks: [
            .toolCall(callId: "c_1", name: "run_command", args: ["command": .string("make")])
          ]
        ),
        replaces: nil
      ),
      to: state
    )
    #expect(toolRows(presenter.transcript(for: state)).first?.isRunning == true)

    state = Reducer.apply(
      .append(message: message("e_12", role: .user, blocks: [.text("再试一次")]), replaces: nil),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(toolRows(entries).first?.isRunning == false, "the finished run's call stays settled")
    #expect(entries.contains { if case .typing = $0 { true } else { false } })
  }
}
