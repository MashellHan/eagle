import BotsCore
import BotsTransport
import Foundation
import SwiftUI

/// One selected bot: connection, transcript, composer and the error surface. All daemon
/// interaction goes through the ports, so this layer can be tested with fakes
/// (docs/bots/ARCHITECTURE.md, "Layers").
@MainActor
public final class ConversationViewModel: ObservableObject {
  @Published public private(set) var state: ConversationState
  @Published public private(set) var connection: ConnectionState = .connecting
  @Published public private(set) var errorBanner: String?
  @Published public private(set) var isSending = false
  @Published public private(set) var hasOlder = false
  @Published public var draft = ""

  private let conversation: ConversationPort
  private let outbox: OutboxStore
  private let now: () -> Date
  private var eventsTask: Task<Void, Never>?
  private var selectedBotId: String?
  /// Sends the user asked for that have not been confirmed yet.
  private var inFlight: [String: String] = [:]
  /// The absolute catalog a `bots` frame carries, for the window's sidebar.
  public var onCatalog: (([BotSummary]) -> Void)?

  public init(
    botId: String = "",
    conversation: ConversationPort,
    outbox: OutboxStore,
    now: @escaping () -> Date = { Date() }
  ) {
    self.state = ConversationState(botId: botId)
    self.conversation = conversation
    self.outbox = outbox
    self.now = now
  }

  public var title: String { selectedBotId ?? "" }
  public var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && connection == .ready
      && state.unavailable == nil
  }

  /// Connects to a bot and replaces the transcript with its snapshot. Selecting the same bot
  /// again is a no-op, so a list refresh does not reconnect.
  public func select(botId: String) {
    if selectedBotId == botId, eventsTask != nil { return }
    eventsTask?.cancel()
    selectedBotId = botId
    state = ConversationState(botId: botId)
    connection = .connecting
    errorBanner = nil
    let stream = conversation.open(botId: botId)
    eventsTask = Task { [weak self] in
      for await event in stream {
        guard let self, !Task.isCancelled else { return }
        self.apply(event)
      }
    }
  }

  public func disconnect() {
    eventsTask?.cancel()
    eventsTask = nil
    selectedBotId = nil
    conversation.close()
    connection = .stopped
  }

  public func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, connection == .ready, let botId = selectedBotId else { return }
    let requestId = Identifiers.request()
    draft = ""
    send(text: text, requestId: requestId, botId: botId, optimistic: true)
  }

  /// Retrying keeps the original requestId, which is how it is recovered, including after a
  /// restart of the app (`OutboxStore`).
  public func retry(_ entry: OutboxEntry) {
    send(text: entry.text, requestId: entry.requestId, botId: entry.botId, optimistic: true)
  }

  public func abort() {
    let context = CommandContext.command("abort")
    Task { [weak self] in
      do {
        try await self?.conversation.abort(context: context)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func recover() {
    let context = CommandContext.command("recover")
    Task { [weak self] in
      do {
        try await self?.conversation.recover(context: context)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func loadOlder() {
    guard let oldest = state.messages.first(where: { !$0.isOptimistic })?.id else { return }
    let context = CommandContext.command("history")
    Task { [weak self] in
      do {
        try await self?.conversation.loadHistory(before: oldest, context: context)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func dismissError() {
    errorBanner = nil
  }

  // MARK: - Sending

  private func send(text: String, requestId: String, botId: String, optimistic: Bool) {
    isSending = true
    if optimistic {
      state = Reducer.apply(
        .append(message: .optimistic(requestId: requestId, text: text), replaces: nil),
        to: state
      )
    }
    inFlight[requestId] = text
    // Persisted before the frame is written (PROTOCOL.md, client duties 1).
    try? outbox.add(OutboxEntry(botId: botId, requestId: requestId, text: text))
    let context = CommandContext.send(requestId)
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.conversation.send(text, whenBusy: .followUp, context: context)
        self.isSending = false
      } catch {
        self.isSending = false
        self.errorBanner = Self.describe(error)
      }
    }
  }

  // MARK: - Events

  private func apply(_ event: ConversationEvent) {
    switch event {
    case .connection(let next):
      connection = next
      if case .ready = next {
        // Reconciliation: every stored entry is re-sent with its own requestId, and pi
        // answers with the stored record (PROTOCOL.md, client duties 2).
        for entry in outbox.entries(for: selectedBotId ?? "") {
          send(
            text: entry.text,
            requestId: entry.requestId,
            botId: entry.botId,
            optimistic: !state.messages.contains { $0.requestId == entry.requestId }
          )
        }
      }
    case .snapshot(let value):
      state = Reducer.snapshot(value, rev: state.lastRev.map { $0 + 1 })
      // The snapshot is authoritative for placements: an entry it lists is not lost.
      for message in value.messages {
        if let requestId = message.requestId {
          inFlight.removeValue(forKey: requestId)
          try? outbox.remove(requestId: requestId)
        }
      }
    case .append(let message, let replaces):
      state = Reducer.apply(.append(message: message, replaces: replaces), to: state)
    case .delta(let messageId, let changes):
      state = Reducer.apply(.delta(messageId: messageId, changes: changes), to: state)
    case .status(let running, let inbox, let streaming):
      state = Reducer.apply(
        .status(running: running, inbox: inbox, streaming: streaming),
        to: state
      )
    case .submission(let record):
      state = Reducer.apply(.submission(record), to: state)
      if record.status.isTerminal {
        inFlight.removeValue(forKey: record.requestId)
        try? outbox.remove(requestId: record.requestId)
      }
    case .history(let page):
      state = Reducer.apply(.history(page: page), to: state)
      hasOlder = page.hasMore
    case .catalog(let bots):
      onCatalog?(bots)
    case .error(let kind, let disposition, let message, _, let requestId):
      errorBanner = message
      state = applyUnavailable(kind: kind)
      switch disposition {
      case .notAdmitted:
        // The daemon refused before admission: drop the bubble and the outbox entry.
        if let requestId {
          inFlight.removeValue(forKey: requestId)
          try? outbox.remove(requestId: requestId)
          state.messages.removeAll { $0.id == "local_\(requestId)" }
        }
      case .unknown:
        // Admission could not be confirmed: keep the bubble and the entry for a retry.
        break
      case .runtime:
        break
      }
      if let requestId, state.pending.contains(where: { $0.requestId == requestId }) {
        state.pending.removeAll { $0.requestId == requestId }
      }
    }
  }

  private func applyUnavailable(kind: ErrorKind) -> ConversationState {
    guard kind == .storageFailed || kind == .internalError else { return state }
    var next = state
    next.unavailable = BotUnavailable(reason: kind, message: "the bot is unavailable")
    next.messages = []
    next.pending = []
    next.inbox = []
    next.streaming = nil
    next.running = false
    return next
  }

  private static func describe(_ error: Error) -> String {
    if let client = error as? ClientError { return client.message }
    return error.localizedDescription
  }
}
