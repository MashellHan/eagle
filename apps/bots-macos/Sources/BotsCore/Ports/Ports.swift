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
