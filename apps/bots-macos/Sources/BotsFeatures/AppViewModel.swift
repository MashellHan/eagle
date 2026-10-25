import BotsCore
import Foundation
import SwiftUI

/// The window's state: the catalog, the selection, and the conversation that follows it.
/// Creating a bot goes to the daemon over HTTP; the catalog then arrives absolute on the
/// socket (PROTOCOL I7).
@MainActor
public final class AppViewModel: ObservableObject {
  @Published public private(set) var bots: [BotSummary] = []
  @Published public private(set) var selection: String?
  @Published public private(set) var error: String?
  @Published public private(set) var isLoading = false
  @Published public var newBotTitle = ""
  @Published public var showingSettings = false

  public let conversation: ConversationViewModel
  private let catalog: CatalogPort
  private var outbox: OutboxStore

  public init(catalog: CatalogPort, conversation: ConversationViewModel, outbox: OutboxStore) {
    self.catalog = catalog
    self.conversation = conversation
    self.outbox = outbox
    conversation.onCatalog = { [weak self] bots in
      self?.bots = bots
      self?.keepSelectionValid()
    }
  }

  public var selectedBot: BotSummary? {
    guard let selection else { return nil }
    return bots.first { $0.id == selection }
  }

  public var draftCount: Int { conversation.draft.count }

  public func start() async {
    await refresh()
    if selection == nil, let first = bots.first {
      select(first.id)
    }
  }

  public func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      bots = try await catalog.load()
      keepSelectionValid()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func createBot() async {
    await createBot(title: newBotTitle)
    if !newBotTitle.isEmpty { newBotTitle = "" }
  }

  public func createBot(title rawTitle: String) async {
    await createBot(title: rawTitle, label: nil, appearance: .standard)
  }

  /// A bot is its name, an optional label and a face; everything else is the daemon's.
  public func createBot(
    title rawTitle: String,
    label: String?,
    appearance: BotAppearance
  ) async {
    var title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    if title.isEmpty { title = "新 Bot" }
    let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    isLoading = true
    defer { isLoading = false }
    do {
      let created = try await catalog.create(
        title: title,
        label: trimmedLabel?.isEmpty == true ? nil : trimmedLabel,
        appearance: appearance
      )
      if rawTitle == newBotTitle { newBotTitle = "" }
      bots = try await catalog.load()
      select(created.id)
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func rename(_ bot: BotSummary, to title: String) async {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    do {
      _ = try await catalog.rename(id: bot.id, title: trimmed)
      bots = try await catalog.load()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func delete(_ bot: BotSummary) async {
    do {
      if selection == bot.id { conversation.disconnect() }
      try await catalog.delete(id: bot.id)
      bots = try await catalog.load()
      keepSelectionValid()
      if selection == nil, let first = bots.first {
        select(first.id)
      }
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func select(_ botId: String) {
    selection = botId
    conversation.select(botId: botId)
  }

  public func pendingOutbox(for botId: String) -> [OutboxEntry] {
    (try? outbox.entries(for: botId)) ?? []
  }

  public func dismissError() {
    error = nil
  }

  private func keepSelectionValid() {
    if let selection, !bots.contains(where: { $0.id == selection }) {
      self.selection = nil
      conversation.disconnect()
    }
    if selection == nil, let first = bots.first {
      select(first.id)
    }
  }

  private func describe(_ error: Error) -> String {
    if let client = error as? ClientError { return client.message }
    return error.localizedDescription
  }
}
