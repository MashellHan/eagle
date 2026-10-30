import BotsCore
import BotsFeatures
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

@MainActor
@Suite("Bots window connection lifecycle", .serialized)
struct BotsWindowLifecycleTests {
  private func model(_ id: String) -> AppViewModel {
    let catalog = StubCatalog()
    catalog.bots = [
      BotSummary(
        id: id, title: id, createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle)
    ]
    let outbox = OutboxStore(
      directory: FileManager.default.temporaryDirectory
        .appendingPathComponent("bots-window-lifecycle-\(UUID().uuidString)"))
    return AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(conversation: StubConversation(), outbox: outbox),
      outbox: outbox)
  }

  @Test("concurrent readiness notifications share one connection attempt")
  func concurrentStarts() async throws {
    let factory = PendingApps()
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]), makeApp: { _ in try await factory.make() },
      gatewayProbe: { true })
    defer { bots.disconnect() }
    let first = Task { await bots.start() }
    await factory.waitForCalls(1)
    var secondTask: Task<Void, Never>?
    await withCheckedContinuation { entered in
      secondTask = Task {
        entered.resume()
        await bots.start()
      }
    }
    let second = try #require(secondTask)
    #expect(factory.calls == 1)
    factory.finishAll(model("b_shared"))
    await first.value
    await second.value
    #expect(factory.calls == 1)
    #expect(bots.isConnected)
    #expect(bots.items.map(\.id) == ["b_shared"])
  }

  @Test("closing a window rejects a late connection result")
  func closedWindow() async throws {
    let factory = PendingApps()
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]), makeApp: { _ in try await factory.make() },
      gatewayProbe: { true })
    let start = Task { await bots.start() }
    await factory.waitForCalls(1)
    bots.disconnect()
    factory.finishAll(model("b_closed"))
    await start.value
    #expect(!bots.isConnected)
    #expect(bots.items.isEmpty)
    bots.disconnect()
  }

  @Test("an old connection cannot replace a reopened window connection")
  func replacedConnection() async throws {
    let factory = PendingApps()
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]), makeApp: { _ in try await factory.make() },
      gatewayProbe: { true })
    defer { bots.disconnect() }
    let old = Task { await bots.start() }
    await factory.waitForCalls(1)
    bots.disconnect()
    let current = Task { await bots.start() }
    await factory.waitForCalls(2)
    factory.finish(1, model("b_current"))
    await current.value
    factory.finish(0, model("b_old"))
    await old.value
    #expect(bots.isConnected)
    #expect(bots.items.map(\.id) == ["b_current"])
  }

  @Test("readiness after an initial failure connects without reopening the window")
  func retryAfterFailure() async throws {
    var attempts = 0
    let app = model("b_retry")
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]),
      makeApp: { _ in
        attempts += 1
        if attempts == 1 { throw CocoaError(.fileReadNoSuchFile) }
        return app
      }, gatewayProbe: { true })
    defer { bots.disconnect() }
    await bots.start()
    #expect(!bots.isConnected)
    #expect(bots.error != nil)
    await bots.start()
    #expect(bots.isConnected)
    #expect(bots.items.map(\.id) == ["b_retry"])
    #expect(attempts == 2)
  }
}

@MainActor
private final class PendingApps {
  private(set) var calls = 0
  private var pending: [Int: CheckedContinuation<AppViewModel, Error>] = [:]
  private var callWaiters: [Int: CheckedContinuation<Void, Never>] = [:]
  private var releasedModel: AppViewModel?

  func waitForCalls(_ count: Int) async {
    if calls < count {
      await withCheckedContinuation { callWaiters[count] = $0 }
    }
    #expect(calls == count)
  }

  func make() async throws -> AppViewModel {
    let index = calls
    calls += 1
    return try await withCheckedThrowingContinuation { continuation in
      if let releasedModel {
        continuation.resume(returning: releasedModel)
      } else {
        pending[index] = continuation
      }
      callWaiters.removeValue(forKey: calls)?.resume()
    }
  }

  func finish(_ index: Int, _ model: AppViewModel) {
    pending.removeValue(forKey: index)?.resume(returning: model)
  }

  func finishAll(_ model: AppViewModel) {
    releasedModel = model
    for index in Array(pending.keys) { finish(index, model) }
  }
}
