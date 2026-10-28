import BotsCore
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Shared deployment authority", .serialized)
@MainActor
struct BotSharedConnectionTests {
  private func connection(_ host: String) throws -> MachineConnection {
    try MachineConnection(
      address: "https://\(host).example.test", ownerToken: String(repeating: "v", count: 40))
  }
  private func target(origin: String) -> BotRemoteTarget {
    BotRemoteTarget(
      alias: "mac", enabled: true, origin: origin, machineId: "mac-b",
      credentialRef: "fixture-reference", operations: [.readFile])
  }

  @Test func anUnsharedConnectionDoesNotRequireBots() async throws {
    let old = try connection("old")
    let new = try connection("new")
    let vault = RemoteGrantVaultFixture(old)
    let sharing = MemoryBotRemoteSharingStore()
    let writer = BotSharedConnectionWriter(
      vault: vault, sharing: sharing, coordinator: BotRemoteAccessCoordinator(),
      port: { throw RemoteToolsError.unavailable })
    try await writer.save(new, replacing: old, stillCurrent: { true })
    #expect(vault.value == new)
  }

  @Test func changingDeploymentClearsPriorBotAuthorityBeforeTheVaultChanges() async throws {
    let old = try connection("old")
    let new = try connection("new")
    let vault = RemoteGrantVaultFixture(old)
    let sharing = MemoryBotRemoteSharingStore()
    sharing.remember(origin: old.origin.absoluteString)
    let port = RemoteGrantPortFixture()
    port.current = BotRemoteConfiguration(
      namespace: port.current.namespace, revision: "rev", helperAvailable: true,
      cleanupPending: false, targets: [target(origin: old.origin.absoluteString)])
    port.afterSave = { #expect(vault.value == old) }
    let writer = BotSharedConnectionWriter(
      vault: vault, sharing: sharing, coordinator: BotRemoteAccessCoordinator(), port: { port })
    try await writer.save(new, replacing: old, stillCurrent: { true })
    #expect(port.current.targets.isEmpty)
    #expect(vault.value == new)
    #expect(!sharing.contains(origin: old.origin.absoluteString))
  }

  @Test func pendingCleanupKeepsTheOldConnectionAndAllowsAnExplicitRetry() async throws {
    let old = try connection("old")
    let new = try connection("new")
    let vault = RemoteGrantVaultFixture(old)
    let sharing = MemoryBotRemoteSharingStore()
    sharing.remember(origin: old.origin.absoluteString)
    let port = RemoteGrantPortFixture()
    port.current = BotRemoteConfiguration(
      namespace: port.current.namespace, revision: "rev", helperAvailable: true,
      cleanupPending: true, targets: [])
    port.cleanupAfterSave = true
    let writer = BotSharedConnectionWriter(
      vault: vault, sharing: sharing, coordinator: BotRemoteAccessCoordinator(), port: { port })
    await #expect(throws: (any Error).self) {
      try await writer.save(new, replacing: old, stillCurrent: { true })
    }
    #expect(vault.value == old)
    #expect(sharing.contains(origin: old.origin.absoluteString))
    port.cleanupAfterSave = false
    try await writer.save(new, replacing: old, stillCurrent: { true })
    #expect(vault.value == new)
  }

  @Test func aGrantInFlightBlocksConnectionReplacementAndStaleWindowsCannotSave() async throws {
    let old = try connection("old")
    let new = try connection("new")
    let vault = RemoteGrantVaultFixture(old)
    let coordinator = BotRemoteAccessCoordinator()
    let writer = BotSharedConnectionWriter(
      vault: vault, sharing: MemoryBotRemoteSharingStore(), coordinator: coordinator,
      port: { throw RemoteToolsError.unavailable })
    let grant = try coordinator.beginGrant()
    await #expect(throws: (any Error).self) {
      try await writer.save(new, replacing: old, stillCurrent: { true })
    }
    #expect(vault.value == old)
    coordinator.endGrant(grant)
    await #expect(throws: (any Error).self) {
      try await writer.save(new, replacing: old, stillCurrent: { false })
    }
    #expect(vault.value == old)
    try await writer.save(new, replacing: old, stillCurrent: { true })
    #expect(vault.value == new)
  }

  @Test func aReadThatReturnsAfterDepartureCannotRevokeAnyBot() async throws {
    let old = try connection("old")
    let new = try connection("new")
    let vault = RemoteGrantVaultFixture(old)
    let sharing = MemoryBotRemoteSharingStore()
    sharing.remember(origin: old.origin.absoluteString)
    let port = RemoteGrantPortFixture()
    port.current = BotRemoteConfiguration(
      namespace: port.current.namespace, revision: "rev", helperAvailable: true,
      cleanupPending: false, targets: [target(origin: old.origin.absoluteString)])
    var active = true
    port.afterRead = { active = false }
    let writer = BotSharedConnectionWriter(
      vault: vault, sharing: sharing, coordinator: BotRemoteAccessCoordinator(), port: { port })
    await #expect(throws: (any Error).self) {
      try await writer.save(new, replacing: old, stillCurrent: { active })
    }
    #expect(port.writes.isEmpty)
    #expect(vault.value == old)
    #expect(sharing.contains(origin: old.origin.absoluteString))
  }
}
