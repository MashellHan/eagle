import BotsCore
import BotsFeatures
import BotsTransport
import XCTest

/// The window's groups: the catalog's order is the sidebar's order, a bot is filed by
/// `move`, and a refused delete is shown instead of emptying the group
/// (docs/bots/PROTOCOL.md, "Group rules").
@MainActor
final class AppViewModelGroupTests: XCTestCase {
  private var outboxDirectory: URL!

  override func setUp() async throws {
    outboxDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-groups-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: outboxDirectory)
  }

  private func makeModel() -> (AppViewModel, FakeCatalog) {
    let catalog = FakeCatalog()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(
        botId: "", conversation: FakeConversation(), outbox: outbox),
      outbox: outbox
    )
    return (model, catalog)
  }

  func testCreatingAGroupAppendsItInTheDaemonsOrder() async throws {
    let (model, catalog) = makeModel()
    catalog.groups = [BotGroup(id: "g_1", title: "工作")]
    await model.refresh()
    XCTAssertEqual(model.groups.map(\.title), ["工作"])

    await model.createGroup(title: "  研究  ")
    XCTAssertEqual(catalog.createdGroupTitles, ["研究"], "the title is trimmed before the daemon")
    XCTAssertEqual(model.groups.map(\.title), ["工作", "研究"])
    XCTAssertNil(model.error)
  }

  func testRenamingAndReorderingFollowTheDaemon() async throws {
    let (model, catalog) = makeModel()
    catalog.groups = [BotGroup(id: "g_1", title: "一"), BotGroup(id: "g_2", title: "二")]
    await model.refresh()

    await model.renameGroup("g_2", to: "学习")
    XCTAssertEqual(catalog.renamedGroups.map { "\($0.0)=\($0.1)" }, ["g_2=学习"])
    XCTAssertEqual(model.groups.map(\.title), ["一", "学习"])

    await model.reorderGroups(["g_2", "g_1"])
    XCTAssertEqual(catalog.reordered, [["g_2", "g_1"]])
    XCTAssertEqual(model.groups.map(\.id), ["g_2", "g_1"], "the daemon's answer is the order")
  }

  func testMovingABotFilesItAndClearingTheGroupUnfilesIt() async throws {
    let (model, catalog) = makeModel()
    catalog.groups = [BotGroup(id: "g_1", title: "工作")]
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      )
    ]
    await model.refresh()
    XCTAssertNil(model.bots.first?.groupId)

    await model.moveBot("b_1", toGroup: "g_1")
    XCTAssertEqual(catalog.moved.map { "\($0.0)=\($0.1 ?? "nil")" }, ["b_1=g_1"])
    XCTAssertEqual(model.bots.first?.groupId, "g_1")

    await model.moveBot("b_1", toGroup: nil)
    XCTAssertEqual(catalog.moved.last?.1, nil, "a nil group is the ungrouped request")
    XCTAssertNil(model.bots.first?.groupId)
  }

  func testARefusedDeleteIsShownAndTheGroupStays() async throws {
    let (model, catalog) = makeModel()
    catalog.groups = [BotGroup(id: "g_1", title: "工作")]
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle, groupId: "g_1"
      )
    ]
    await model.refresh()
    catalog.refuseDelete = ClientError("the group still holds bots")

    await model.deleteGroup("g_1")
    XCTAssertEqual(model.error, "the group still holds bots", "the daemon's reason is what shows")
    XCTAssertEqual(model.groups.map(\.id), ["g_1"], "nothing was emptied")
    XCTAssertEqual(catalog.deletedGroups, [], "the daemon refused it")
  }

  func testDeletingAnEmptyGroupRemovesIt() async throws {
    let (model, catalog) = makeModel()
    catalog.groups = [BotGroup(id: "g_1", title: "空组")]
    await model.refresh()

    await model.deleteGroup("g_1")
    XCTAssertEqual(catalog.deletedGroups, ["g_1"])
    XCTAssertTrue(model.groups.isEmpty)
    XCTAssertNil(model.error)
  }

  func testAPushedCatalogReplacesTheGroupsToo() async throws {
    let (model, catalog) = makeModel()
    let conversation = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let pushed = AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(botId: "", conversation: conversation, outbox: outbox),
      outbox: outbox
    )
    catalog.groups = [BotGroup(id: "g_1", title: "一")]
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle
      )
    ]
    await pushed.refresh()
    XCTAssertEqual(pushed.groups.map(\.id), ["g_1"])

    conversation.emit(
      .catalog(
        BotCatalog(
          bots: [],
          groups: [BotGroup(id: "g_9", title: "推来的")]
        ))
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(pushed.groups.map(\.id), ["g_9"], "a bots event is absolute")
  }
}
