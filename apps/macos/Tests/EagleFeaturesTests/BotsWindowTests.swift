import BotsCore
import BotsFeatures
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

/// What the shell binds: the Bots window keeps one draft in the conversation view model,
/// publishes the transcript and the actions, and a refusal's restored text is the value the
/// composer shows.
@MainActor
@Suite("Bots window")
struct BotsWindowTests {
  private func window(
    gateway: Bool? = true
  ) async throws -> (
    BotsWorkspaceViewModel, AppViewModel, StubConversation, OutboxStore
  ) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-window-\(UUID().uuidString)", isDirectory: true)
    let catalog = StubCatalog()
    catalog.bots = [
      BotSummary(
        id: "b_1",
        title: "研究员",
        createdAt: "x",
        updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"),
        state: .idle
      )
    ]
    let conversationPort = StubConversation()
    let outbox = OutboxStore(directory: directory)
    let conversation = ConversationViewModel(
      botId: "",
      conversation: conversationPort,
      outbox: outbox
    )
    let app = AppViewModel(catalog: catalog, conversation: conversation, outbox: outbox)
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]),
      makeApp: { _ in app },
      gatewayProbe: { gateway }
    )
    await bots.start()
    bots.select("b_1")
    conversationPort.emit(.connection(.ready))
    conversationPort.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 60_000_000)
    return (bots, app, conversationPort, outbox)
  }

  @Test("the composer and the conversation share one draft")
  func singleDraft() async throws {
    let (bots, app, conversationPort, _) = try await window()
    bots.setDraft("hello from Eagle")
    #expect(bots.draft == "hello from Eagle")
    #expect(app.conversation.draft == "hello from Eagle", "there is no second draft")

    bots.send()
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(conversationPort.sent.last?.text == "hello from Eagle")

    // A refusal restores the text through the same accessor the composer binds.
    let requestId = try #require(conversationPort.sent.last?.requestId)
    conversationPort.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.draft == "hello from Eagle", "the restored draft is what the user sees")
  }

  @Test("a send without a gateway is refused into the setup hint, not the daemon")
  func missingGatewayHaltsSend() async throws {
    let (bots, _, conversationPort, _) = try await window(gateway: false)
    bots.setDraft("hello")
    bots.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(bots.needsModelSetup, "the user is told to configure the gateway")
    #expect(conversationPort.sent.isEmpty, "nothing was sent")
    bots.dismissModelSetup()
    #expect(!bots.needsModelSetup)
  }

  @Test("a parked task offers recover and the action reaches the daemon")
  func parkedIsRecoverable() async throws {
    let (bots, _, conversationPort, _) = try await window()
    conversationPort.emit(
      .error(
        kind: .taskParked,
        disposition: .runtime,
        message: "a task was parked",
        failure: "f_parked",
        requestId: nil
      )
    )
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.canRecover, "a parked task is a recoverable state")
    bots.recover()
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(conversationPort.recovered == 1, "recover reaches the daemon")
    #expect(conversationPort.lastBotId == "b_1")
  }

  @Test("the transcript is published from append and delta events")
  func transcriptPublished() async throws {
    let (bots, _, conversationPort, _) = try await window()
    conversationPort.emit(
      .append(
        message: Message(
          id: "e_7",
          role: .user,
          state: .complete,
          createdAt: "x",
          blocks: [.text("问题")],
          requestId: "r_1"
        ),
        replaces: nil
      )
    )
    conversationPort.emit(
      .append(
        message: Message(
          id: "p_a1",
          role: .assistant,
          state: .streaming,
          createdAt: "x",
          blocks: [.text("回")]
        ),
        replaces: nil
      )
    )
    conversationPort.emit(.delta(messageId: "p_a1", changes: [.text(index: 0, append: "答")]))
    try await Task.sleep(nanoseconds: 80_000_000)
    let rows = bots.entries
    #expect(rows.count >= 2, "the transcript grows with the stream")
    #expect(
      {
        if case .streamingAssistant(_, let blocks) = rows.last,
          case .paragraph("回答") = blocks.first
        {
          return true
        }
        return false
      }(), "the streamed answer is what the window renders")
  }

  @Test("the window publishes the transcript, the status and the actions")
  func publishedState() async throws {
    let (bots, app, conversationPort, _) = try await window()
    #expect(app.bots.count == 1)
    #expect(bots.items.count == 1, "the sidebar gets a row per bot")
    #expect(bots.connection == .ready)
    #expect(bots.subtitle == "已连接")

    conversationPort.emit(.status(running: true, inbox: [], streaming: nil))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.running, "the stop affordance is driven by the run state")

    bots.abort()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(conversationPort.aborted == 1, "stop goes through the bot it belongs to")
    #expect(conversationPort.lastBotId == "b_1")
  }
}

/// The two ports this window needs, with just enough behaviour for the bindings.
final class StubCatalog: CatalogPort {
  var bots: [BotSummary] = []

  func load() async throws -> [BotSummary] { bots }
  func create(title: String, label: String?, appearance: BotAppearance) async throws -> BotSummary {
    let bot = BotSummary(
      id: "b_new",
      title: title,
      label: label,
      appearance: appearance,
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .idle
    )
    bots.append(bot)
    return bot
  }
  var updated: [(String?, String?, BotAppearance?)] = []

  func update(
    id: String,
    title: String?,
    label: String?,
    appearance: BotAppearance?
  ) async throws -> BotSummary {
    guard let index = bots.firstIndex(where: { $0.id == id }) else { return bots[0] }
    var bot = bots[index]
    if let title { bot.title = title }
    if let label { bot.label = label.isEmpty ? nil : label }
    if let appearance { bot.appearance = appearance }
    bots[index] = bot
    updated.append((title, label, appearance))
    return bot
  }
  func rename(id: String, title: String) async throws -> BotSummary { bots[0] }
  func delete(id: String) async throws { bots.removeAll { $0.id == id } }
  func catalogEvents() -> AsyncStream<[BotSummary]> { AsyncStream { $0.finish() } }
}

final class StubConversation: ConversationPort {
  struct Sent {
    let text: String
    let requestId: String
  }

  var sent: [Sent] = []
  var aborted = 0
  var lastBotId: String?
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

  var recovered = 0

  func recover(context: CommandContext, botId: String) async throws {
    recovered += 1
    lastBotId = botId
  }

  func resync(context: CommandContext, botId: String) async throws {
    lastBotId = botId
  }

  func loadHistory(before messageId: String, context: CommandContext, botId: String) async throws {
    lastBotId = botId
  }

  func close() {
    continuation?.finish()
    continuation = nil
  }
}
