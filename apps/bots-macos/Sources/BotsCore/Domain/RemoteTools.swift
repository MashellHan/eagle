import Foundation

public enum RemoteToolPermission: String, Codable, CaseIterable, Sendable {
  case command = "command.exec"
  case readFile = "file.read"
  case listFiles = "file.list"
  case setupHerdr = "herdr.setup"
  case inspectHerdr = "herdr.inspect"
}

/// Non-secret authority metadata. Credentials are never sent to the daemon API.
public struct BotRemoteTarget: Codable, Equatable, Sendable, Identifiable {
  public var alias: String
  public var enabled: Bool
  public var origin: String
  public var machineId: String
  public var credentialRef: String
  public var operations: [RemoteToolPermission]
  public var id: String { alias }

  public init(
    alias: String, enabled: Bool, origin: String, machineId: String,
    credentialRef: String, operations: [RemoteToolPermission]
  ) {
    self.alias = alias
    self.enabled = enabled
    self.origin = origin
    self.machineId = machineId
    self.credentialRef = credentialRef
    self.operations = operations
  }
}

public struct BotRemoteConfiguration: Codable, Equatable, Sendable {
  public let namespace: String
  public let revision: String
  public let helperAvailable: Bool
  public let cleanupPending: Bool
  public let targets: [BotRemoteTarget]
  public init(
    namespace: String, revision: String, helperAvailable: Bool,
    cleanupPending: Bool, targets: [BotRemoteTarget]
  ) {
    self.namespace = namespace
    self.revision = revision
    self.helperAvailable = helperAvailable
    self.cleanupPending = cleanupPending
    self.targets = targets
  }
}

public enum RemoteToolsError: Error, Equatable, Sendable {
  case invalid, authentication, conflict, unavailable
}

public protocol RemoteToolsPort: Sendable {
  func botIDs() async throws -> [String]
  func read(botID: String) async throws -> BotRemoteConfiguration
  func save(botID: String, revision: String, targets: [BotRemoteTarget]) async throws
    -> BotRemoteConfiguration
}
