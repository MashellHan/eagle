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
        .toolCall(callId: "c_1", name: "search"),
        .toolResult(callId: "c_1", text: "工具结果", isError: false),
      ],
      stopReason: .length
    )
    state = Reducer.apply(.append(message: message, replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    #expect(
      {
        if case .assistant(_, let blocks) = entries.first {
          return blocks == [.paragraph("可见"), .note("回答因为长度上限被截断。")]
        }
        return false
      }())
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
