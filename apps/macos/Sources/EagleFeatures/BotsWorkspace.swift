import BotsCore
import BotsFeatures
import BotsTransport
import Combine
import EagleDesign
import Foundation

/// Where the shell finds the daemon. The token always comes from `<root>/token`; the port
/// is the daemon's default 43117. A development shell can point elsewhere with the
/// `BOTS_ROOT` / `BOTS_PORT` environment variables.
struct BotsSettings {
  let rootPath: String
  let port: String

  init(environment: [String: String] = ProcessInfo.processInfo.environment) {
    rootPath = environment["BOTS_ROOT"] ?? TokenStore.defaultRoot.path
    port = environment["BOTS_PORT"] ?? "43117"
  }

  var rootURL: URL { URL(fileURLWithPath: rootPath, isDirectory: true) }

  var baseURL: URL {
    URL(string: "http://127.0.0.1:\(Int(port) ?? 43117)") ?? URL(string: "http://127.0.0.1:43117")!
  }
}

/// The Bots group in the shell's sidebar and the conversation it opens. This is the
/// window's view model for Bots: it owns the connection, the catalog, the selected bot and
/// the draft, and it republishes the domain state as Eagle's transcript entries. The views
/// only bind to it.
@MainActor
final class BotsWorkspaceViewModel: ObservableObject {
  @Published private(set) var items: [SidebarItem] = []
  @Published private(set) var entries: [TranscriptEntry] = []
  @Published private(set) var title = "Bots"
  @Published private(set) var subtitle = "正在连接…"
  @Published private(set) var tintIndex = 0
  @Published private(set) var selectedId: String?
  @Published private(set) var error: String?
  @Published private(set) var canRecover = false
  @Published private(set) var running = false
  @Published private(set) var connection: ConnectionState = .connecting

  /// The shell owns the sidebar's selection; the view model reports the bot it selected.
  var onSelect: ((String) -> Void)?

  private let settings: BotsSettings
  private let presenter = BotsPresenter()
  private var app: AppViewModel?
  private var cancellables = Set<AnyCancellable>()

  init(settings: BotsSettings = BotsSettings()) {
    self.settings = settings
  }

  var section: SidebarSection? {
    guard !items.isEmpty else { return nil }
    return SidebarSection(id: "bots", title: "Bots", count: items.count, items: items)
  }

  var isConnected: Bool { app != nil }

  func owns(_ id: String?) -> Bool {
    guard let id else { return false }
    return items.contains { $0.id == id }
  }

  /// Connects once. A failure is shown in the sidebar's subtitle, not as a new surface.
  func start() async {
    guard app == nil else { return }
    do {
      let token = try TokenStore(root: settings.rootURL).read()
      let catalog = CatalogHTTPClient(baseURL: settings.baseURL, token: token)
      // A health check first: a missing token or a stopped daemon is a setup problem, not
      // an empty catalog.
      _ = try await catalog.load()
      let connection = BotsConnection(baseURL: settings.baseURL, token: token)
      let outbox = OutboxStore()
      let conversation = ConversationViewModel(conversation: connection, outbox: outbox)
      let model = AppViewModel(catalog: catalog, conversation: conversation, outbox: outbox)
      app = model
      bind(model)
      await model.refresh()
      publish()
      // The shell keeps its own landing selection (the demo workspace) unless a
      // development shell asks to open Bots directly.
      if ProcessInfo.processInfo.environment["BOTS_OPEN"] == "1", let first = app?.bots.first {
        select(first.id)
      }
    } catch {
      subtitle = (error as? ClientError)?.message ?? error.localizedDescription
      self.error = subtitle
    }
  }

  func select(_ id: String) {
    guard let app, owns(id) else { return }
    selectedId = id
    app.select(id)
    // The sidebar's selection is the shell's, so a programmatic selection (a new bot, a
    // development shell) moves the list too.
    onSelect?(id)
    publish()
  }

  func createBot() async {
    await createBot(title: "", label: nil, appearance: .standard)
  }

  /// A created bot is real immediately: the daemon writes it, the catalog returns it, and
  /// the sidebar selects it.
  func createBot(title: String, label: String?, appearance: BotAppearance) async {
    guard let app else { return }
    await app.createBot(title: title, label: label, appearance: appearance)
    if let created = app.selection {
      selectedId = created
      onSelect?(created)
    }
    publish()
  }

  func rename(_ id: String, to title: String) async {
    guard let app, let bot = app.bots.first(where: { $0.id == id }) else { return }
    await app.rename(bot, to: title)
    publish()
  }

  func remove(_ id: String) async {
    guard let app, let bot = app.bots.first(where: { $0.id == id }) else { return }
    await app.delete(bot)
    if selectedId == id {
      selectedId = app.selection
      if let next = app.selection { onSelect?(next) }
    }
    publish()
  }

  /// The conversation view model owns the only draft; the composer reads and writes it
  /// through these two members, so there is no second copy to drift.
  var draft: String { app?.conversation.draft ?? "" }

  func setDraft(_ value: String) {
    app?.conversation.draft = value
  }

  func send() {
    guard let app else { return }
    app.conversation.send()
    publish()
  }

  func recover() {
    app?.conversation.recover()
    publish()
  }

  func abort() {
    app?.conversation.abort()
    publish()
  }

  func dismissError() {
    app?.conversation.dismissError()
    app?.dismissError()
    publish()
  }

  func refresh() async {
    await app?.refresh()
    publish()
  }

  /// Domain state in, Eagle's transcript out. Called after every published change.
  private func publish() {
    guard let app else {
      items = []
      entries = []
      return
    }
    items = app.bots.map(presenter.sidebarItem)
    if app.selection != selectedId, let next = app.selection {
      selectedId = next
      onSelect?(next)
    }
    guard let selected = app.bots.first(where: { $0.id == app.selection }) else {
      title = "Bots"
      subtitle = app.bots.isEmpty ? "还没有 Bot，点 + 新建一个" : "选择一个 Bot"
      entries = []
      canRecover = false
      return
    }
    title = selected.title
    tintIndex = presenter.tintIndex(for: selected)
    let conversation = app.conversation
    subtitle = presenter.subtitle(for: conversation.state, connection: conversation.connection)
    entries = presenter.transcript(for: conversation.state)
    running = conversation.state.running
    connection = conversation.connection
    canRecover = conversation.state.unavailable != nil
    error = conversation.errorBanner ?? app.error
  }

  /// The conversation view model publishes many times per answer (one delta each), so the
  /// mapping runs on the next run loop turn rather than inside the notification.
  private func bind(_ app: AppViewModel) {
    cancellables.removeAll()
    app.objectWillChange
      .merge(with: app.conversation.objectWillChange)
      .sink { [weak self] _ in
        Task { @MainActor [weak self] in self?.publish() }
      }
      .store(in: &cancellables)
  }
}

/// Pure presentation: domain state in, Eagle's transcript entries out
/// (docs/bots/PLAN.md, stage 5 — view models own the mapping, views only render).
struct BotsPresenter {
  func transcript(for state: ConversationState) -> [TranscriptEntry] {
    var rows: [TranscriptEntry] = []
    for message in state.messages {
      rows.append(contentsOf: entries(for: message))
    }
    if let typing = typingEntry(for: state) {
      rows.append(typing)
    }
    if let unavailable = state.unavailable {
      rows.append(
        .assistant(id: "unavailable", blocks: [.note("这个 Bot 暂时不可用：\(unavailable.message)")])
      )
    }
    return rows
  }

  func entries(for message: Message) -> [TranscriptEntry] {
    switch message.role {
    case .user:
      return [.user(id: message.id, text: message.text)]
    case .assistant:
      // An attempt with no text yet is represented by the single typing row `transcript`
      // adds; only visible text becomes a bubble.
      let answer = message.visibleText
      if answer.isEmpty, message.state == .streaming {
        return []
      }
      var blocks: [AssistantTurn.Block] = answer.isEmpty ? [] : [.paragraph(answer)]
      if message.state == .aborted {
        blocks.append(.note("回答已中止"))
      } else if message.state == .error {
        blocks.append(.note("回答失败，可以重新发送。"))
      } else if message.stopReason == .length {
        blocks.append(.note("回答因为长度上限被截断。"))
      }
      return [.assistant(id: message.id, blocks: blocks)]
    case .notice:
      return [.assistant(id: message.id, blocks: [.note(message.text)])]
    }
  }

  /// While a run works and there is no growing text yet, the transcript shows the typing
  /// row: the first token has not arrived, or the run moved on to another round.
  func typingEntry(for state: ConversationState) -> TranscriptEntry? {
    guard state.unavailable == nil, state.running else { return nil }
    if let streaming = state.streamingMessage, !streaming.text.isEmpty { return nil }
    return .typing(id: "typing-run")
  }

  func subtitle(for state: ConversationState, connection: ConnectionState) -> String {
    if state.unavailable != nil { return "不可用" }
    if state.running { return "回答中" }
    switch connection {
    case .connecting: return "正在连接…"
    case .ready: return "已连接"
    case .reconnecting(let attempt): return "正在重连（第 \(attempt) 次）"
    case .failed(let reason): return reason
    case .stopped: return "已断开"
    }
  }

  func tintIndex(for bot: BotSummary) -> Int {
    abs(bot.id.hashValue) % Theme.Palette.avatarTints.count
  }

  func sidebarItem(for bot: BotSummary) -> SidebarItem {
    SidebarItem(
      id: bot.id,
      title: bot.title,
      subtitle: stateLabel(for: bot),
      tag: bot.state == .running ? "回答中" : bot.label,
      tintIndex: tintIndex(for: bot),
      face: faceStyle(for: bot)
    )
  }

  /// The daemon's closed sets and Eagle's are the same ids, so the picker and the row
  /// draw what the user chose.
  func faceStyle(for bot: BotSummary) -> BotFace.Style {
    BotFace.Style(
      shape: BotFace.Shape(rawValue: bot.face.shape.rawValue) ?? .blob,
      tint: Theme.Palette.BotTint(rawValue: bot.face.tint.rawValue) ?? .green
    )
  }

  private func stateLabel(for bot: BotSummary) -> String {
    switch bot.state {
    case .running: return "正在回答"
    case .idle: return "空闲"
    case .opening: return "打开中"
    case .catalogued: return "未打开"
    case .unavailable: return bot.unavailable?.message ?? "不可用"
    case .quarantined: return "隔离中"
    }
  }
}
