import BotsCore
import Foundation

@MainActor public final class BotSharedConnectionWriter: MachineConnectionSaving {
  private let vault: any MachineCredentialVault
  private let sharing: any BotRemoteSharingStore
  private let coordinator: BotRemoteAccessCoordinator
  private let port: () throws -> any RemoteToolsPort
  public init(
    vault: any MachineCredentialVault, sharing: any BotRemoteSharingStore,
    coordinator: BotRemoteAccessCoordinator, port: @escaping () throws -> any RemoteToolsPort
  ) {
    self.vault = vault
    self.sharing = sharing
    self.coordinator = coordinator
    self.port = port
  }
  public func requiresRevocation(origin: String) throws -> Bool {
    try sharing.contains(origin: origin)
  }
  public func save(
    _ connection: MachineConnection, replacing old: MachineConnection?,
    stillCurrent: @escaping @MainActor () -> Bool
  ) async throws {
    let lease = try coordinator.beginConnectionChange()
    defer { coordinator.endConnectionChange(lease) }
    guard !Task.isCancelled, stillCurrent(), try vault.load() == old else {
      throw BotRemoteGrantError.changedConnection
    }
    let replacingShared: Bool
    if let old, old != connection {
      replacingShared = try sharing.contains(origin: old.origin.absoluteString)
    } else {
      replacingShared = false
    }
    if let old, replacingShared {
      let port = try port()
      for bot in try await port.botIDs() {
        guard !Task.isCancelled, stillCurrent() else { throw BotRemoteGrantError.changedConnection }
        let current = try await port.read(botID: bot)
        guard !Task.isCancelled, stillCurrent(), try vault.load() == old else {
          throw BotRemoteGrantError.changedConnection
        }
        let retained = current.targets.filter { $0.origin != old.origin.absoluteString }
        if retained.count != current.targets.count || current.cleanupPending {
          let result = try await port.save(
            botID: bot, revision: current.revision, targets: retained)
          guard !result.cleanupPending,
            !result.targets.contains(where: { $0.origin == old.origin.absoluteString })
          else {
            throw BotRemoteGrantError.cleanupPending
          }
        }
      }
    }
    guard !Task.isCancelled, stillCurrent(), try vault.load() == old else {
      throw BotRemoteGrantError.changedConnection
    }
    if let old, replacingShared { try sharing.forget(origin: old.origin.absoluteString) }
    try vault.save(connection)
  }
}
