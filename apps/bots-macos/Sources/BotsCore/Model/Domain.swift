import Foundation

/// Domain types mirroring the daemon's `core/domain.ts` one to one, so a fixture, a log
/// line and a Swift value use the same words (docs/bots/PROTOCOL.md, "Entities").

public enum ErrorKind: String, Codable, Sendable {
  case authFailed = "auth_failed"
  case unknownBot = "unknown_bot"
  case invalidCommand = "invalid_command"
  case limitExceeded = "limit_exceeded"
  case versionMismatch = "version_mismatch"
  case modelError = "model_error"
  case sessionFailed = "session_failed"
  case taskFaulted = "task_faulted"
  case taskParked = "task_parked"
  case extensionError = "extension_error"
  case storageFailed = "storage_failed"
  case internalError = "internal"
}

public enum ErrorDisposition: String, Codable, Sendable {
  case notAdmitted = "not_admitted"
  case unknown
  case runtime
}

public enum MessageRole: String, Codable, Sendable {
  case user, assistant, notice
}

public enum MessageState: String, Codable, Sendable {
  case streaming, complete, aborted, error
}

public enum StopReason: String, Codable, Sendable {
  case stop, length, toolUse, aborted, error, deferred
}

public enum ContentBlock: Codable, Sendable, Equatable {
  case text(String)
  case thinking(String)
  case toolCall(callId: String, name: String)
  case toolResult(callId: String, text: String, isError: Bool)

  private enum CodingKeys: String, CodingKey {
    case type, text, callId, name, args, isError
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .type) {
    case "text":
      self = .text(try container.decode(String.self, forKey: .text))
    case "thinking":
      self = .thinking(try container.decode(String.self, forKey: .text))
    case "toolCall":
      self = .toolCall(
        callId: try container.decode(String.self, forKey: .callId),
        name: try container.decode(String.self, forKey: .name)
      )
    case "toolResult":
      self = .toolResult(
        callId: try container.decode(String.self, forKey: .callId),
        text: try container.decode(String.self, forKey: .text),
        isError: try container.decode(Bool.self, forKey: .isError)
      )
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type,
        in: container,
        debugDescription: "unknown block type"
      )
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .text(let text):
      try container.encode("text", forKey: .type)
      try container.encode(text, forKey: .text)
    case .thinking(let text):
      try container.encode("thinking", forKey: .type)
      try container.encode(text, forKey: .text)
    case .toolCall(let callId, let name):
      try container.encode("toolCall", forKey: .type)
      try container.encode(callId, forKey: .callId)
      try container.encode(name, forKey: .name)
      try container.encode([String: String](), forKey: .args)
    case .toolResult(let callId, let text, let isError):
      try container.encode("toolResult", forKey: .type)
      try container.encode(callId, forKey: .callId)
      try container.encode(text, forKey: .text)
      try container.encode(isError, forKey: .isError)
    }
  }

  /// The text a transcript shows for this block. Tool blocks are not rendered in phase 1.
  public var displayText: String {
    switch self {
    case .text(let text), .thinking(let text): return text
    case .toolResult(_, let text, _): return text
    case .toolCall: return ""
    }
  }
}

public struct Message: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var role: MessageRole
  public var state: MessageState
  public var createdAt: String
  public var blocks: [ContentBlock]
  public var requestId: String?
  public var stopReason: StopReason?

  public init(
    id: String,
    role: MessageRole,
    state: MessageState,
    createdAt: String,
    blocks: [ContentBlock],
    requestId: String? = nil,
    stopReason: StopReason? = nil
  ) {
    self.id = id
    self.role = role
    self.state = state
    self.createdAt = createdAt
    self.blocks = blocks
    self.requestId = requestId
    self.stopReason = stopReason
  }

  public var text: String { blocks.map(\.displayText).joined() }

  /// `p_a1` is a provisional streamed message; `e_7` is a committed entry.
  public var isProvisional: Bool { id.hasPrefix("p_") }
}

public enum BotState: String, Codable, Sendable {
  case catalogued, opening, idle, running, unavailable, quarantined
}

public struct ModelRef: Codable, Sendable, Equatable {
  public var provider: String
  public var modelId: String

  public init(provider: String, modelId: String) {
    self.provider = provider
    self.modelId = modelId
  }
}

public struct BotUnavailable: Codable, Sendable, Equatable {
  public var reason: ErrorKind
  public var message: String

  public init(reason: ErrorKind, message: String) {
    self.reason = reason
    self.message = message
  }
}

public struct BotSummary: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var title: String
  public var createdAt: String
  public var updatedAt: String
  public var model: ModelRef
  public var state: BotState
  public var unavailable: BotUnavailable?

  public init(
    id: String,
    title: String,
    createdAt: String,
    updatedAt: String,
    model: ModelRef,
    state: BotState,
    unavailable: BotUnavailable? = nil
  ) {
    self.id = id
    self.title = title
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.model = model
    self.state = state
    self.unavailable = unavailable
  }
}

public enum SubmissionStatus: String, Codable, Sendable {
  case queued, placed, done, unanswered

  /// `queued < placed < done = unanswered`: a record only moves up (PROTOCOL I14).
  public var rank: Int {
    switch self {
    case .queued: return 0
    case .placed: return 1
    case .done, .unanswered: return 2
    }
  }

  public var isTerminal: Bool { self == .done || self == .unanswered }
}

public struct Submission: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var requestId: String
  public var status: SubmissionStatus
  public var entryId: String?
  public var answerEntryId: String?
  public var reason: String?

  public init(
    id: String,
    requestId: String,
    status: SubmissionStatus,
    entryId: String? = nil,
    answerEntryId: String? = nil,
    reason: String? = nil
  ) {
    self.id = id
    self.requestId = requestId
    self.status = status
    self.entryId = entryId
    self.answerEntryId = answerEntryId
    self.reason = reason
  }

  private enum CodingKeys: String, CodingKey {
    case id, submissionId, requestId, status, entryId, answerEntryId, reason
  }

  /// A snapshot's `pending` names the record by `submissionId`; everything else calls it
  /// `id` in this client (PROTOCOL.md, `ConversationSnapshot.pending`).
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let id = try container.decodeIfPresent(String.self, forKey: .id) {
      self.id = id
    } else {
      self.id = try container.decode(String.self, forKey: .submissionId)
    }
    requestId = try container.decode(String.self, forKey: .requestId)
    status = try container.decode(SubmissionStatus.self, forKey: .status)
    entryId = try container.decodeIfPresent(String.self, forKey: .entryId)
    answerEntryId = try container.decodeIfPresent(String.self, forKey: .answerEntryId)
    reason = try container.decodeIfPresent(String.self, forKey: .reason)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .submissionId)
    try container.encode(requestId, forKey: .requestId)
    try container.encode(status, forKey: .status)
    try container.encodeIfPresent(entryId, forKey: .entryId)
    try container.encodeIfPresent(answerEntryId, forKey: .answerEntryId)
    try container.encodeIfPresent(reason, forKey: .reason)
  }
}

public struct InboxItem: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var mode: String

  public init(id: String, mode: String) {
    self.id = id
    self.mode = mode
  }
}

public struct ConversationSnapshot: Codable, Sendable, Equatable {
  public var botId: String
  public var messages: [Message]
  public var truncatedBefore: String?
  public var streaming: String?
  public var pending: [Submission]
  public var inbox: [InboxItem]
  public var running: Bool
  public var unavailable: BotUnavailable?

  public init(
    botId: String,
    messages: [Message] = [],
    truncatedBefore: String? = nil,
    streaming: String? = nil,
    pending: [Submission] = [],
    inbox: [InboxItem] = [],
    running: Bool = false,
    unavailable: BotUnavailable? = nil
  ) {
    self.botId = botId
    self.messages = messages
    self.truncatedBefore = truncatedBefore
    self.streaming = streaming
    self.pending = pending
    self.inbox = inbox
    self.running = running
    self.unavailable = unavailable
  }

  private enum CodingKeys: String, CodingKey {
    case botId, messages, truncatedBefore, streaming, pending, inbox, running, unavailable
    case agent, usage
  }

  /// `streaming` is `{ "messageId": "p_a1" }` on the wire and `null` when no attempt is in
  /// flight; the client only needs the id.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    botId = try container.decode(String.self, forKey: .botId)
    messages = try container.decodeIfPresent([Message].self, forKey: .messages) ?? []
    truncatedBefore = try container.decodeIfPresent(String.self, forKey: .truncatedBefore)
    pending = try container.decodeIfPresent([Submission].self, forKey: .pending) ?? []
    inbox = try container.decodeIfPresent([InboxItem].self, forKey: .inbox) ?? []
    running = try container.decodeIfPresent(Bool.self, forKey: .running) ?? false
    unavailable = try container.decodeIfPresent(BotUnavailable.self, forKey: .unavailable)
    if let pointer = try container.decodeIfPresent(StreamingPointer.self, forKey: .streaming) {
      streaming = pointer.messageId
    } else {
      streaming = nil
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(botId, forKey: .botId)
    try container.encode(messages, forKey: .messages)
    try container.encodeIfPresent(truncatedBefore, forKey: .truncatedBefore)
    try container.encodeIfPresent(pending, forKey: .pending)
    try container.encode(inbox, forKey: .inbox)
    try container.encode(running, forKey: .running)
    try container.encodeIfPresent(unavailable, forKey: .unavailable)
    if let streaming {
      try container.encode(StreamingPointer(messageId: streaming), forKey: .streaming)
    } else {
      try container.encodeNil(forKey: .streaming)
    }
  }

  private struct StreamingPointer: Codable {
    let messageId: String
  }
}

public enum DeltaChange: Codable, Sendable, Equatable {
  case text(index: Int, append: String)
  case thinking(index: Int, append: String)
  case toolCall(index: Int, callId: String, path: [String], append: String)
  case block(index: Int, block: ContentBlock)
  case message(Message)

  private enum CodingKeys: String, CodingKey {
    case kind, index, append, callId, path, block, message
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .kind) {
    case "text":
      self = .text(
        index: try container.decode(Int.self, forKey: .index),
        append: try container.decode(String.self, forKey: .append)
      )
    case "thinking":
      self = .thinking(
        index: try container.decode(Int.self, forKey: .index),
        append: try container.decode(String.self, forKey: .append)
      )
    case "toolcall":
      self = .toolCall(
        index: try container.decode(Int.self, forKey: .index),
        callId: try container.decodeIfPresent(String.self, forKey: .callId) ?? "",
        path: (try container.decodeIfPresent([JSONPathComponent].self, forKey: .path) ?? []).map(
          \.value
        ),
        append: try container.decodeIfPresent(String.self, forKey: .append) ?? ""
      )
    case "block":
      self = .block(
        index: try container.decode(Int.self, forKey: .index),
        block: try container.decode(ContentBlock.self, forKey: .block)
      )
    case "message":
      self = .message(try container.decode(Message.self, forKey: .message))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .kind,
        in: container,
        debugDescription: "unknown delta kind"
      )
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .text(let index, let append):
      try container.encode("text", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(append, forKey: .append)
    case .thinking(let index, let append):
      try container.encode("thinking", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(append, forKey: .append)
    case .toolCall(let index, let callId, let path, let append):
      try container.encode("toolcall", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(callId, forKey: .callId)
      try container.encode(path.map(JSONPathComponent.string), forKey: .path)
      try container.encode(append, forKey: .append)
    case .block(let index, let block):
      try container.encode("block", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(block, forKey: .block)
    case .message(let message):
      try container.encode("message", forKey: .kind)
      try container.encode(message, forKey: .message)
    }
  }

  /// A tool path mixes object keys and array indexes; the client never writes one.
  private enum JSONPathComponent: Codable {
    case string(String)
    case number(Int)
    var value: String {
      switch self {
      case .string(let text): return text
      case .number(let number): return String(number)
      }
    }
    init(from decoder: Decoder) throws {
      let container = try decoder.singleValueContainer()
      if let text = try? container.decode(String.self) {
        self = .string(text)
      } else {
        self = .number(try container.decode(Int.self))
      }
    }
    func encode(to encoder: Encoder) throws {
      var container = encoder.singleValueContainer()
      switch self {
      case .string(let text): try container.encode(text)
      case .number(let number): try container.encode(number)
      }
    }
  }
}

public enum BusyMode: String, Codable, Sendable {
  case followUp, steer, reject
}

public struct HistoryPage: Sendable, Equatable {
  public var messages: [Message]
  public var hasMore: Bool

  public init(messages: [Message], hasMore: Bool) {
    self.messages = messages
    self.hasMore = hasMore
  }
}
