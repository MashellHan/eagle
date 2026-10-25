import BotsCore
import BotsFeatures
import BotsTransport
import XCTest

/// The window's catalog: create selects the new bot, delete removes it, and a pushed
/// catalog replaces the list (PROTOCOL I7).
@MainActor
final class CatalogTests: XCTestCase {
  private var outboxDirectory: URL!

  override func setUp() async throws {
    outboxDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-catalog-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: outboxDirectory)
  }

  private func makeModel() -> (AppViewModel, FakeCatalog, FakeConversation) {
    let catalog = FakeCatalog()
    let conversation = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(botId: "", conversation: conversation, outbox: outbox),
      outbox: outbox
    )
    return (model, catalog, conversation)
  }

  func testCreateSelectsTheNewBot() async throws {
    let (model, catalog, _) = makeModel()
    await model.refresh()
    XCTAssertNil(model.selection)

    model.newBotTitle = "研究员"
    await model.createBot()

    XCTAssertEqual(catalog.created, ["研究员"])
    XCTAssertEqual(model.bots.map(\.title), ["研究员"])
    XCTAssertEqual(model.selection, catalog.bots.first?.id, "the new bot is selected")
    XCTAssertEqual(model.newBotTitle, "", "the field clears")
  }

  func testDeleteRemovesTheBotAndSelectsTheNextOne() async throws {
    let (model, catalog, _) = makeModel()
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      ),
      BotSummary(
        id: "b_2", title: "二", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      ),
    ]
    await model.refresh()
    XCTAssertEqual(model.selection, "b_1")

    await model.delete(catalog.bots[0])
    XCTAssertEqual(catalog.deleted, ["b_1"])
    XCTAssertEqual(model.bots.map(\.id), ["b_2"])
    XCTAssertEqual(model.selection, "b_2", "the next bot is selected")
  }

  func testAPushedCatalogReplacesTheList() async throws {
    let (model, catalog, conversation) = makeModel()
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      )
    ]
    await model.refresh()
    XCTAssertEqual(model.selection, "b_1")
    conversation.emit(
      .catalog([
        BotSummary(
          id: "b_9", title: "推来的", createdAt: "x", updatedAt: "x",
          model: ModelRef(provider: "p", modelId: "m"), state: .running
        )
      ])
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(model.bots.map(\.id), ["b_9"], "a bots event is absolute")
    XCTAssertEqual(model.selection, "b_9", "the selection follows the catalog")
    XCTAssertEqual(model.bots.first?.state, .running)
    XCTAssertEqual(catalog.created, [], "no HTTP create was needed")
  }
}

final class FakeCatalog: CatalogPort {
  var bots: [BotSummary] = []
  var created: [String] = []
  var labels: [String?] = []
  var faces: [BotAppearance] = []
  var deleted: [String] = []
  var failNext = false

  func load() async throws -> [BotSummary] {
    if failNext {
      failNext = false
      throw ClientError("the daemon is not reachable")
    }
    return bots
  }

  func create(
    title: String,
    label: String?,
    appearance: BotAppearance
  ) async throws -> BotSummary {
    created.append(title)
    labels.append(label)
    faces.append(appearance)
    let bot = BotSummary(
      id: "b_\(UUID().uuidString.prefix(8))",
      title: title,
      label: label,
      appearance: appearance,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: ModelRef(provider: "faux", modelId: "faux-1"),
      state: .idle
    )
    bots.append(bot)
    return bot
  }

  func rename(id: String, title: String) async throws -> BotSummary {
    guard let bot = bots.first(where: { $0.id == id }) else {
      throw ClientError("unknown bot")
    }
    var renamed = bot
    renamed.title = title
    bots = bots.map { $0.id == id ? renamed : $0 }
    return renamed
  }

  func delete(id: String) async throws {
    deleted.append(id)
    bots.removeAll { $0.id == id }
  }

  func catalogEvents() -> AsyncStream<[BotSummary]> {
    AsyncStream { $0.finish() }
  }
}

@MainActor
final class SettingsTests: XCTestCase {
  func testTokenIsReadFromTheRootAndRefusedWhenUnusable() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-token-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let store = TokenStore(root: root)
    XCTAssertThrowsError(try store.read(), "a missing token is a setup error, not a crash")

    try "short\n".write(to: store.tokenURL, atomically: true, encoding: .utf8)
    XCTAssertThrowsError(try store.read(), "a truncated token is not usable")

    let issued = String(repeating: "a", count: 43)
    try "\(issued)\n".write(to: store.tokenURL, atomically: true, encoding: .utf8)
    XCTAssertEqual(try store.read(), issued)
  }

  func testTwoStoresMergeTheirEntriesInsteadOfOverwritingEachOther() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-outbox-merge-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = OutboxStore(directory: directory)
    let second = OutboxStore(directory: directory)
    try first.add(OutboxEntry(botId: "b_1", requestId: "r_first", text: "一"))
    // The second window never saw the first entry: its write must merge, not replace.
    try second.add(OutboxEntry(botId: "b_1", requestId: "r_second", text: "二"))
    XCTAssertEqual(
      Set(try OutboxStore(directory: directory).all().map(\.requestId)),
      ["r_first", "r_second"]
    )
  }

  func testATerminalRecordIsStoredBeforeItsEntryLeaves() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-outbox-settle-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = OutboxStore(directory: directory)
    try store.add(OutboxEntry(botId: "b_1", requestId: "r_1", text: "问"))
    try store.settle(
      Submission(
        id: "s_1",
        requestId: "r_1",
        status: .unanswered,
        reason: "aborted"
      ),
      botId: "b_1"
    )
    XCTAssertEqual(try store.all(), [], "the entry leaves")
    let settled = try store.settledRequests()
    XCTAssertEqual(settled.map(\.requestId), ["r_1"], "the settlement is durable")
    XCTAssertEqual(settled.first?.status, .unanswered)
    XCTAssertEqual(settled.first?.reason, "aborted")
  }

  func testAnUnreadableOutboxIsNeverTreatedAsEmpty() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-outbox-broken-\(UUID().uuidString)", isDirectory: true)
    let file = directory.appendingPathComponent("outbox.json")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      try? FileManager.default.removeItem(at: directory)
    }
    try
      "{\"entries\":[{\"botId\":\"b_1\",\"requestId\":\"r_1\",\"text\":\"一\",\"whenBusy\":\"followUp\",\"createdAt\":\"x\"}],\"settled\":[]}"
      .write(
        to: file,
        atomically: true,
        encoding: .utf8
      )
    try "not json at all".write(to: file, atomically: true, encoding: .utf8)
    let store = OutboxStore(directory: directory)
    XCTAssertThrowsError(try store.all(), "an unreadable outbox is unknown, not empty")
    XCTAssertThrowsError(
      try store.add(OutboxEntry(botId: "b_1", requestId: "r_2", text: "二")),
      "a read failure must fail the write, not overwrite the file"
    )
    // A malformed file is not overwritten by a failed mutation either.
    XCTAssertEqual(
      try String(contentsOf: file, encoding: .utf8),
      "not json at all",
      "the file was left untouched"
    )
  }

  func testOutboxSurvivesARestartAndKeepsItsMode() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-outbox-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let entry = OutboxEntry(botId: "b_1", requestId: "r_1", text: "还没送到的话")
    try OutboxStore(directory: directory).add(entry)

    let reopened = OutboxStore(directory: directory)
    XCTAssertEqual(try reopened.entries(for: "b_1"), [entry], "the outbox is durable")
    let attributes = try FileManager.default.attributesOfItem(
      atPath: directory.appendingPathComponent("outbox.json").path
    )
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    try reopened.remove(requestId: "r_1")
    XCTAssertEqual(try OutboxStore(directory: directory).all(), [])
  }

  func testRenameUpdatesTheListAndErrorsAreReported() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-outbox-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let catalog = FakeCatalog()
    let conversation = ConversationViewModel(
      botId: "",
      conversation: FakeConversation(),
      outbox: OutboxStore(directory: directory)
    )
    let model = AppViewModel(
      catalog: catalog,
      conversation: conversation,
      outbox: OutboxStore(directory: directory)
    )
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "旧名", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      )
    ]
    await model.refresh()
    await model.rename(catalog.bots[0], to: "新名")
    XCTAssertEqual(model.bots.first?.title, "新名")

    catalog.failNext = true
    await model.refresh()
    XCTAssertNotNil(model.error, "a failed refresh is shown, not swallowed")
    model.dismissError()
    XCTAssertNil(model.error)
  }
}

@MainActor
final class AppViewModelTests: XCTestCase {
  private func make(failNext: Bool = false) -> (AppViewModel, FakeCatalog) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-app-\(UUID().uuidString)", isDirectory: true)
    let catalog = FakeCatalog()
    catalog.failNext = failNext
    let model = AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(
        botId: "",
        conversation: FakeConversation(),
        outbox: OutboxStore(directory: directory)
      ),
      outbox: OutboxStore(directory: directory)
    )
    return (model, catalog)
  }

  func testComposeCreatesABotWithADefaultNameWhenTheFieldIsEmpty() async throws {
    let (model, catalog) = make()
    await model.refresh()
    await model.createBot()
    XCTAssertEqual(catalog.created, ["新 Bot"])
    XCTAssertEqual(model.bots.map(\.title), ["新 Bot"])
    XCTAssertNotNil(model.selection)
  }

  func testAStartWithNoBotsSelectsNothingAndReportsTheFailure() async throws {
    let (model, _) = make()
    await model.start()
    XCTAssertNil(model.selection)
    XCTAssertTrue(model.bots.isEmpty)

    let (failing, _) = make(failNext: true)
    await failing.start()
    XCTAssertNotNil(failing.error)
  }

  func testDeletingTheSelectedBotSelectsTheNextOneOrNone() async throws {
    let (model, catalog) = make()
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      ),
      BotSummary(
        id: "b_2", title: "二", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      ),
    ]
    await model.refresh()
    await model.delete(catalog.bots[0])
    XCTAssertEqual(model.selection, "b_2")
    await model.delete(catalog.bots[0])
    XCTAssertNil(model.selection, "the last bot leaves nothing selected")
  }
}

@MainActor
final class TokenStoreTests: XCTestCase {
  func testAnEnvironmentTokenWinsAndTheFileIsTheFallback() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-token-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let fromEnvironment = TokenStore(root: root, environment: ["BOTS_TOKEN": "  env-token  "])
    XCTAssertEqual(try fromEnvironment.read(), "env-token")

    let issued = String(repeating: "b", count: 43)
    try "\(issued)\n".write(
      to: root.appendingPathComponent("token"),
      atomically: true,
      encoding: .utf8
    )
    XCTAssertEqual(try TokenStore(root: root, environment: [:]).read(), issued)
  }
}

@MainActor
final class AppPathsTests: XCTestCase {
  func testTheSupportDirectoryIsCreatedOwnerOnly() throws {
    let directory = try AppPaths.ensureSupportDirectory()
    var isDirectory: ObjCBool = false
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory)
    )
    XCTAssertTrue(isDirectory.boolValue)
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    XCTAssertTrue(AppPaths.supportDirectory.path.contains("ai.hexly.bots"))
  }
}
