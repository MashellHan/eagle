import BotsCore
import BotsTransport
import Foundation

/// The client's persisted outbox (docs/bots/PROTOCOL.md, "Client duties"): a send is stored
/// before its frame is written, and only a terminal record or `not_admitted` removes it.
public struct OutboxEntry: Codable, Sendable, Equatable, Identifiable {
  public var botId: String
  public var requestId: String
  public var text: String
  public var whenBusy: BusyMode
  public var createdAt: String

  public var id: String { requestId }

  public init(
    botId: String,
    requestId: String,
    text: String,
    whenBusy: BusyMode = .followUp,
    createdAt: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.botId = botId
    self.requestId = requestId
    self.text = text
    self.whenBusy = whenBusy
    self.createdAt = createdAt
  }
}

public final class OutboxStore {
  /// Every window has its own view model, so writes re-read the file under one lock
  /// before merging: two windows must not overwrite each other's entries.
  private static let lock = NSLock()

  private let directory: URL
  private let fileURL: URL
  private var cache: [OutboxEntry]

  public init(directory: URL = AppPaths.supportDirectory) {
    self.directory = directory
    self.fileURL = directory.appendingPathComponent("outbox.json")
    self.cache = []
    if let data = try? Data(contentsOf: fileURL),
      let entries = try? JSONDecoder().decode([OutboxEntry].self, from: data)
    {
      self.cache = entries
    }
  }

  public func entries(for botId: String) -> [OutboxEntry] {
    cache.filter { $0.botId == botId }
  }

  public func all() -> [OutboxEntry] { cache }

  public func add(_ entry: OutboxEntry) throws {
    try mutate { entries in
      var next = entries
      next.removeAll { $0.requestId == entry.requestId }
      next.append(entry)
      return next
    }
  }

  public func remove(requestId: String) throws {
    try mutate { entries in
      var next = entries
      next.removeAll { $0.requestId == requestId }
      return next
    }
  }

  /// Read-modify-write under the process lock, so a stale in-memory cache from another
  /// window cannot drop an entry this instance never saw.
  private func mutate(_ change: ([OutboxEntry]) -> [OutboxEntry]) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    var entries =
      (try? Data(contentsOf: fileURL))
      .flatMap { try? JSONDecoder().decode([OutboxEntry].self, from: $0) } ?? []
    entries = change(entries)
    cache = entries
    try persist()
  }

  private func persist() throws {
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let data = try JSONEncoder().encode(cache)
    try data.write(to: fileURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
  }
}
