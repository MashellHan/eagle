import BotsCore
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Native per-Bot authority", .serialized)
@MainActor
struct BotRemoteGrantTests {
  private func connection() throws -> MachineConnection {
    try MachineConnection(
      address: "https://fixture.example.test", ownerToken: String(repeating: "k", count: 40))
  }
  private func machine() throws -> MachineRow {
    let bytes = Data(
      #"{"id":"machine-b","name":"Build Mac","enabled":true,"createdAt":"2026-10-28T00:00:00Z","updatedAt":"2026-10-28T00:00:00Z"}"#
        .utf8)
    return MachineRow(machine: try JSONDecoder().decode(ManagedMachine.self, from: bytes))
  }
  private func fixture(
    coordinator: BotRemoteAccessCoordinator = BotRemoteAccessCoordinator()
  ) throws -> (
    BotRemoteGrantModel, RemoteGrantPortFixture, RemoteGrantHelperFixture, RemoteGrantVaultFixture,
    MemoryBotRemoteSharingStore
  ) {
    let port = RemoteGrantPortFixture()
    let helper = RemoteGrantHelperFixture()
    let vault = RemoteGrantVaultFixture(try connection())
    let sharing = MemoryBotRemoteSharingStore()
    let row = try machine()
    return (
      BotRemoteGrantModel(
        botID: "bot-a", botTitle: "Bot A", port: port, helper: helper, vault: vault,
        sharing: sharing, coordinator: coordinator, directory: { _ in [row] }), port, helper, vault,
      sharing
    )
  }

  @Test func explicitGrantReservesThenCopiesThenEnablesOnlyThisBot() async throws {
    let (model, port, helper, _, sharing) = try fixture()
    await model.load()
    #expect(model.permissions.isEmpty)
    model.selectedMachineID = "machine-b"
    model.alias = "build-mac"
    await model.grant()
    #expect(port.writes.isEmpty, "no capability is silently selected")
    model.permissions = [.readFile, .setupHerdr]
    helper.beforePut = { binding in
      #expect(port.writes.count == 1)
      #expect(port.current.targets.first?.enabled == false)
      #expect(port.current.targets.first?.credentialRef == binding.credentialRef)
      #expect(sharing.contains(origin: binding.origin))
    }
    await model.grant()
    #expect(port.writes.count == 2)
    #expect(port.botIDsWritten == ["bot-a", "bot-a"])
    #expect(helper.bindings.count == 1)
    #expect(port.current.targets.first?.enabled == true)
    #expect(Set(port.current.targets.first?.operations ?? []) == [.readFile, .setupHerdr])
    #expect(model.configuration == port.current)
  }

  @Test func failedPrivateCopyKeepsDisabledReferenceAndCanRevokeWithoutCloud() async throws {
    let (model, port, helper, vault, _) = try fixture()
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.command]
    helper.fail = true
    await model.grant()
    #expect(port.writes.count == 1)
    #expect(port.current.targets.first?.enabled == false)
    #expect(model.message != nil)
    vault.value = nil
    await model.revoke(alias: "mac")
    #expect(port.current.targets.isEmpty)
    #expect(!model.busy)
  }

  @Test func aConnectionChangedDuringReservationCannotReachPrivateCopyOrActivation() async throws {
    let (model, port, helper, vault, _) = try fixture()
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.readFile]
    port.afterSave = { vault.value = nil }
    await model.grant()
    #expect(port.writes.count == 1)
    #expect(helper.bindings.isEmpty)
    #expect(port.current.targets.first?.enabled == false)
    #expect(!model.busy)
  }

  @Test func pageDepartureDuringPrivateCopyCannotPublishAnEnabledGrant() async throws {
    let (model, port, helper, _, _) = try fixture()
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.readFile]
    helper.beforePut = { _ in model.invalidate() }
    await model.grant()
    #expect(helper.bindings.count == 1)
    #expect(port.writes.count == 1)
    #expect(port.current.targets.first?.enabled == false)
  }

  @Test func failedActivationReadsActualAuthorityInsteadOfRestoringAnOldRevision() async throws {
    let (model, port, _, _, _) = try fixture()
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.inspectHerdr]
    port.failActivation = true
    await model.grant()
    #expect(model.configuration?.revision == port.current.revision)
    #expect(port.current.targets.first?.enabled == false)
    #expect(model.message != nil)
    #expect(!model.busy)
  }

  @Test func anotherWindowCannotReportCleanupBeforeAnInFlightPrivateCopy() async throws {
    let coordinator = BotRemoteAccessCoordinator()
    let (first, port, helper, vault, sharing) = try fixture(coordinator: coordinator)
    let second = BotRemoteGrantModel(
      botID: first.botID, botTitle: "same Bot", port: port, helper: helper,
      vault: vault, sharing: sharing, coordinator: coordinator, directory: { _ in [] })
    await first.load()
    first.selectedMachineID = "machine-b"
    first.alias = "mac"
    first.permissions = [.readFile]
    helper.pause = true
    port.afterSave = { helper.stored.formIntersection(port.current.targets.map(\.credentialRef)) }
    let grant = Task { await first.grant() }
    for _ in 0..<100 {
      if helper.waiting != nil { break }
      await Task.yield()
    }
    #expect(helper.waiting != nil)
    await second.load()
    await second.revoke(alias: "mac")
    #expect(second.message != "授权和凭据清理已确认。")
    helper.release()
    await grant.value
    #expect(helper.stored.isSubset(of: Set(port.current.targets.map(\.credentialRef))))
    await second.load()
    await second.revoke(alias: "mac")
    #expect(port.current.targets.isEmpty)
    #expect(helper.stored.isEmpty)
    #expect(!first.busy && !second.busy)
  }

  @Test func cancellingDuringReservationPreventsThePrivateCopy() async throws {
    let (model, port, helper, _, _) = try fixture()
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.readFile]
    port.afterSave = { withUnsafeCurrentTask { $0?.cancel() } }
    await Task { await model.grant() }.value
    #expect(port.writes.count == 1)
    #expect(helper.bindings.isEmpty)
    #expect(port.current.targets.first?.enabled == false)
    #expect(!model.busy)
  }

  @Test func cancellingDuringPrivateCopyPreventsActivation() async throws {
    let (model, port, helper, _, _) = try fixture()
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.readFile]
    helper.beforePut = { _ in withUnsafeCurrentTask { $0?.cancel() } }
    await Task { await model.grant() }.value
    #expect(helper.bindings.count == 1)
    #expect(port.writes.count == 1)
    #expect(port.current.targets.first?.enabled == false)
    #expect(!model.busy)
  }

  @Test func unavailableHelperExplainsWhyAValidFormCannotBeSaved() async throws {
    let (model, port, _, _, _) = try fixture()
    port.current = BotRemoteConfiguration(
      namespace: port.current.namespace, revision: "rev",
      helperAvailable: false, cleanupPending: false, targets: [])
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.readFile]
    #expect(!model.canGrant)
    #expect(model.grantUnavailableReason?.contains("授权组件") == true)
    #expect(model.canRevoke)
  }

  @Test func cloudReadFailureNamesTheFailedReadAndKeepsLocalRevocation() async throws {
    let port = RemoteGrantPortFixture()
    let model = BotRemoteGrantModel(
      botID: "bot-a", botTitle: "Bot", port: port,
      helper: RemoteGrantHelperFixture(), vault: RemoteGrantVaultFixture(try connection()),
      sharing: MemoryBotRemoteSharingStore(), coordinator: BotRemoteAccessCoordinator(),
      directory: { _ in throw MachineAccessError.unavailable })
    await model.load()
    #expect(model.message?.contains("机器目录") == true)
    #expect(model.message?.contains("未自动重复写入") != true)
    #expect(model.canRevoke)
    #expect(!model.canGrant)
  }

  @Test func aFailedVaultReloadCannotLeaveTheOldGrantFormUsable() async throws {
    let (model, _, _, vault, _) = try fixture()
    await model.load()
    model.selectedMachineID = "machine-b"
    model.alias = "mac"
    model.permissions = [.readFile]
    #expect(model.canGrant)
    vault.readFails = true
    await model.load()
    #expect(!model.canGrant)
    #expect(model.machines.isEmpty)
    #expect(model.canRevoke)
  }

  @Test func botAuthenticationFailureDoesNotPretendTheSavedDeploymentIsAbsent() async throws {
    let (model, port, _, vault, _) = try fixture()
    port.readFailure = RemoteToolsError.authentication
    await model.load()
    #expect(model.connectedAddress == "https://fixture.example.test")
    #expect(vault.reads == 1)
    #expect(model.configuration == nil)
    #expect(!model.canGrant && !model.canRevoke)
    #expect(model.message?.contains("Bot 服务") == true)
  }
}

@MainActor final class RemoteGrantVaultFixture: MachineCredentialVault {
  var value: MachineConnection?
  var readFails = false
  var reads = 0
  init(_ value: MachineConnection?) { self.value = value }
  func load() throws -> MachineConnection? {
    reads += 1
    if readFails { throw MachineAccessError.keychain(-1) }
    return value
  }
  func save(_ connection: MachineConnection) throws { value = connection }
  func remove() throws { value = nil }
}

@MainActor final class RemoteGrantPortFixture: RemoteToolsPort {
  var current = BotRemoteConfiguration(
    namespace: String(repeating: "a", count: 64), revision: "unconfigured", helperAvailable: true,
    cleanupPending: false, targets: [])
  var writes: [[BotRemoteTarget]] = []
  var botIDsWritten: [String] = []
  var afterSave: (() -> Void)?
  var afterRead: (() -> Void)?
  var readFailure: (any Error)?
  var failActivation = false
  var cleanupAfterSave = false
  func botIDs() async throws -> [String] { ["bot-a"] }
  func read(botID: String) async throws -> BotRemoteConfiguration {
    if let readFailure { throw readFailure }
    afterRead?()
    return current
  }
  func save(
    botID: String, revision: String, targets: [BotRemoteTarget]
  ) async throws -> BotRemoteConfiguration {
    guard revision == current.revision else { throw RemoteToolsError.conflict }
    if failActivation && targets.contains(where: \.enabled) { throw RemoteToolsError.conflict }
    writes.append(targets)
    botIDsWritten.append(botID)
    current = BotRemoteConfiguration(
      namespace: current.namespace, revision: UUID().uuidString,
      helperAvailable: true, cleanupPending: cleanupAfterSave, targets: targets)
    afterSave?()
    return current
  }
}

@MainActor final class RemoteGrantHelperFixture: BotRemoteCredentialAccess {
  var bindings: [BotRemoteCredentialBinding] = []
  var fail = false
  var beforePut: ((BotRemoteCredentialBinding) -> Void)?
  var stored: Set<String> = []
  var pause = false
  var waiting: CheckedContinuation<Void, Never>?
  func release() {
    waiting?.resume()
    waiting = nil
  }
  func put(_ binding: BotRemoteCredentialBinding, connection: MachineConnection) async throws {
    bindings.append(binding)
    beforePut?(binding)
    if pause { await withCheckedContinuation { waiting = $0 } }
    if fail { throw LocalAgentError.unavailable }
    stored.insert(binding.credentialRef)
  }
}
