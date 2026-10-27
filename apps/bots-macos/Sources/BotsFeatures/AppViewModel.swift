import BotsCore
import Foundation
import SwiftUI

/// The window's state: the catalog, the selection, and the conversation that follows it.
/// Creating a bot goes to the daemon over HTTP; the catalog then arrives absolute on the
/// socket (PROTOCOL I7).
@MainActor
public final class AppViewModel: ObservableObject {
  @Published public private(set) var bots: [BotSummary] = []
  /// The sidebar groups in the daemon's display order; a bot's `groupId` is its membership.
  @Published public private(set) var groups: [BotGroup] = []
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
    conversation.onCatalog = { [weak self] catalog in
      self?.apply(catalog)
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
      apply(try await catalog.load())
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
      await reload()
      select(created.id)
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func rename(_ bot: BotSummary, to title: String) async {
    await update(bot, title: title)
  }

  /// Edits the name, the label (an empty string clears it) or the face; nil leaves a field
  /// alone. The catalog reload is what the sidebar and inspector rebuild from.
  public func update(
    _ bot: BotSummary,
    title: String? = nil,
    label: String? = nil,
    appearance: BotAppearance? = nil
  ) async {
    let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, trimmedTitle?.isEmpty != false { return }
    let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      _ = try await catalog.update(
        id: bot.id,
        title: trimmedTitle,
        label: trimmedLabel,
        appearance: appearance
      )
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func delete(_ bot: BotSummary) async {
    do {
      if selection == bot.id { conversation.disconnect() }
      try await catalog.delete(id: bot.id)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  // MARK: - Groups

  /// A group is only a name and a place in the sidebar; the daemon chooses its id.
  public func createGroup(title rawTitle: String) async {
    let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    do {
      _ = try await catalog.createGroup(title: title)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func renameGroup(_ id: String, to rawTitle: String) async {
    let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    do {
      _ = try await catalog.renameGroup(id: id, title: title)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  /// A refused delete (a group that still holds a bot) leaves the group where it is and
  /// puts the daemon's reason in `error`.
  public func deleteGroup(_ id: String) async {
    do {
      try await catalog.deleteGroup(id: id)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func reorderGroups(_ ids: [String]) async {
    do {
      groups = try await catalog.reorderGroups(ids: ids)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  /// Files a bot; a nil group unfiles it. The group's own order is never touched.
  public func moveBot(_ id: String, toGroup groupId: String?) async {
    do {
      _ = try await catalog.moveBot(id: id, groupId: groupId)
      await reload()
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

  private func apply(_ catalog: BotCatalog) {
    bots = catalog.bots
    groups = catalog.groups
    keepSelectionValid()
  }

  /// A write is followed by a read: the daemon owns the ids, the order and the memberships.
  private func reload() async {
    do {
      apply(try await catalog.load())
    } catch {
      self.error = describe(error)
    }
  }
}
