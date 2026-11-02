import Foundation

public struct NativeHistoryBranch: Codable, Sendable, Equatable, Identifiable {
  public let branchId: String
  public let conversationId: String
  public let selection: String
  public var id: String { branchId }
  public init(branchId: String, conversationId: String, selection: String) {
    self.branchId = branchId
    self.conversationId = conversationId
    self.selection = selection
  }
}

public struct NativeHistoryView: Codable, Sendable, Equatable {
  public let head: String
  public let branchId: String
  public var usable: Bool
  public let extendsCurrent: Bool?
  public let messages: [Message]
  public init(
    head: String, branchId: String, usable: Bool, messages: [Message], extendsCurrent: Bool? = nil
  ) {
    self.head = head
    self.branchId = branchId
    self.usable = usable
    self.extendsCurrent = extendsCurrent
    self.messages = messages
  }
}

public struct NativeHistoryContinuation: Codable, Sendable {
  public let branchId: String
  public let submission: Submission
  public init(branchId: String, submission: Submission) {
    self.branchId = branchId
    self.submission = submission
  }
}

public protocol NativeHistoryPort: AnyObject {
  func branches(botId: String) async throws -> [NativeHistoryBranch]
  func view(botId: String, head: String, after: String?) async throws -> NativeHistoryView
  func assess(botId: String, head: String) async throws -> Bool
  func continueHistory(botId: String, head: String, text: String, requestId: String) async throws
    -> NativeHistoryContinuation
}

extension NativeHistoryPort {
  public func view(botId: String, head: String) async throws -> NativeHistoryView {
    try await view(botId: botId, head: head, after: nil)
  }
}
