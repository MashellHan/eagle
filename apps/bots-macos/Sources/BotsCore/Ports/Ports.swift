import Foundation

/// What the client receives from the transport. Wire decoding lives there; this is the
/// domain vocabulary the reducer and the view models speak (docs/bots/ARCHITECTURE.md,
/// "Ports").
public enum ConversationEvent: Sendable, Equatable {
  case connection(ConnectionState)
  case snapshot(ConversationSnapshot)
  case append(message: Message, replaces: String?)
  case delta(messageId: String, changes: [DeltaChange])
  case status(running: Bool, inbox: [InboxItem], streaming: String?)
  case submission(Submission)
  case history(page: HistoryPage)
  /// The whole live-task list of the bot; an empty list means nothing runs.
  case tasks([TaskSummary])
  /// The bot's own triggers, whole-list replacement (PROTOCOL.md, "Triggers").
  case triggers([TriggerSummary])
  /// Tokens and cost so far, whenever the daemon's totals move.
  case usage(Usage)
  case catalog(BotCatalog)
  case error(
    kind: ErrorKind,
    disposition: ErrorDisposition,
    message: String,
    failure: String?,
    requestId: String?
  )
}

public enum ConnectionState: Sendable, Equatable {
  case connecting
  case ready
  case reconnecting(attempt: Int)
  case failed(reason: String)
  case stopped
}

/// Command context is created by the view model, so the call site and the daemon share one
/// trace and one requestId (docs/bots/PROTOCOL.md, "Trace ownership").
public struct CommandContext: Sendable, Equatable {
  public let trace: String
  public let requestId: String?

  public init(trace: String, requestId: String? = nil) {
    self.trace = trace
    self.requestId = requestId
  }

  public static func command(_ prefix: String = "cmd") -> CommandContext {
    CommandContext(trace: Identifiers.trace(prefix))
  }

  public static func send(_ requestId: String) -> CommandContext {
    CommandContext(trace: Identifiers.trace("send"), requestId: requestId)
  }
}

/// Identifiers the wire accepts: 8–64 characters of `[A-Za-z0-9_-]` (PROTOCOL.md, limits).
public enum Identifiers {
  public static func trace(_ prefix: String = "cmd") -> String {
    "\(prefix)_\(UUID().uuidString)"
  }

  public static func request() -> String {
    "r_\(UUID().uuidString)"
  }
}

public protocol CatalogPort: AnyObject {
  /// The bots and the groups in one read: a membership only means something with the
  /// groups beside it (PROTOCOL.md, "Group rules").
  func load() async throws -> BotCatalog
  func create(
    title: String,
    label: String?,
    appearance: BotAppearance
  ) async throws -> BotSummary
  /// Edits a bot: a nil field is left alone; an empty label clears the stored one.
  func update(
    id: String,
    title: String?,
    label: String?,
    appearance: BotAppearance?
  ) async throws -> BotSummary
  func rename(id: String, title: String) async throws -> BotSummary
  func delete(id: String) async throws
  func catalogEvents() -> AsyncStream<BotCatalog>

  func createGroup(title: String) async throws -> BotGroup
  func renameGroup(id: String, title: String) async throws -> BotGroup
  /// The daemon refuses while a bot is still filed under it; the message is what shows.
  func deleteGroup(id: String) async throws
  /// The whole order, every group once: the daemon writes nothing partial.
  func reorderGroups(ids: [String]) async throws -> [BotGroup]
  /// Files a bot; a nil group unfiles it.
  func moveBot(id: String, groupId: String?) async throws -> BotSummary
  /// The third-party providers and their saved state.
  func loadProviders() async throws -> [ProviderSettings]
  /// Saves one provider's key or enable flag.
  func saveProvider(id: String, apiKey: String?, enabled: Bool?) async throws -> ProviderSettings
  /// Probes one provider with a single search.
  func testProvider(id: String) async throws -> ProviderProbe
  /// Usage statistics over the retained window.
  func loadUsage(days: Int) async throws -> UsageReport
  /// The model ids the gateway offers.
  func loadModels() async throws -> [String]
  /// The bot's own agent choice; nil fields are left alone.
  func setAgent(id: String, model: String?, thinkingLevel: String?) async throws -> BotSummary
  /// Runs one parked task again; the task graph reports it as live work.
  func retryTask(bot: String, task: String) async throws
  /// Stops one live task; the transcript keeps what it committed.
  func abortTask(bot: String, task: String) async throws
}

public protocol ConversationPort: AnyObject {
  func open(botId: String) -> AsyncStream<ConversationEvent>
  /// `botId` is the connection the caller believes it is writing to; the transport
  /// refuses when the socket now belongs to another bot.
  func send(
    _ text: String,
    whenBusy: BusyMode,
    context: CommandContext,
    botId: String
  ) async throws
  func abort(context: CommandContext, botId: String) async throws
  func recover(context: CommandContext, botId: String) async throws
  func resync(context: CommandContext, botId: String) async throws
  func loadHistory(before messageId: String, context: CommandContext, botId: String) async throws
  func close()
}

/// A failure the client itself produced (no connection, a rejected frame, a bad URL).
public struct ClientError: Error, Sendable, CustomStringConvertible {
  public let message: String

  public init(_ message: String) {
    self.message = message
  }

  public var description: String { message }
}

/// One trigger's read-only detail plus the person's only mutation (docs/bots/TRIGGERS.md
/// §8.3). The daemon's bearer authenticates it; a credential never crosses this port.
public struct TriggerDetail: Sendable, Equatable, Identifiable {
  public var summary: TriggerSummary
  /// The Bot's standing instruction, shown read-only.
  public var prompt: String
  /// Where a webhook delivers, without its credential; nil for a schedule.
  public var endpoint: String?

  public init(summary: TriggerSummary, prompt: String, endpoint: String? = nil) {
    self.summary = summary
    self.prompt = prompt
    self.endpoint = endpoint
  }

  public var id: String { summary.id }
}

public protocol TriggerPort: AnyObject, Sendable {
  func list(botId: String) async throws -> [TriggerDetail]
  /// Switching is the only mutation a person may perform.
  func setEnabled(botId: String, triggerId: String, enabled: Bool) async throws -> TriggerDetail
}
