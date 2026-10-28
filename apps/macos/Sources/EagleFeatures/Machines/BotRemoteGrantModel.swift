import BotsCore
import Combine
import Foundation

public struct BotRemoteCredentialBinding: Codable, Equatable, Sendable {
  public let namespace: String
  public let botId: String
  public let credentialRef: String
  public let origin: String
  public init(namespace: String, botId: String, credentialRef: String, origin: String) {
    self.namespace = namespace
    self.botId = botId
    self.credentialRef = credentialRef
    self.origin = origin
  }
}

public protocol BotRemoteCredentialAccess: Sendable {
  func put(_ binding: BotRemoteCredentialBinding, connection: MachineConnection) async throws
}

@MainActor public protocol BotRemoteSharingStore: AnyObject {
  func remember(origin: String) throws
  func contains(origin: String) throws -> Bool
  func forget(origin: String) throws
}

@MainActor public final class MemoryBotRemoteSharingStore: BotRemoteSharingStore {
  private var origins: Set<String> = []
  public init() {}
  public func remember(origin: String) { origins.insert(origin) }
  public func contains(origin: String) -> Bool { origins.contains(origin) }
  public func forget(origin: String) { origins.remove(origin) }
}

@MainActor public final class BotRemoteAccessCoordinator {
  public static let shared = BotRemoteAccessCoordinator()
  private var grants: [UUID: String] = [:]
  private var changingConnection: UUID?
  public init() {}
  func beginGrant(binding: String = "*") throws -> UUID {
    guard changingConnection == nil,
      !grants.values.contains(where: { $0 == binding || $0 == "*" || binding == "*" })
    else { throw BotRemoteGrantError.busy }
    let id = UUID()
    grants[id] = binding
    return id
  }
  func endGrant(_ id: UUID) { grants.removeValue(forKey: id) }
  func beginConnectionChange() throws -> UUID {
    guard changingConnection == nil, grants.isEmpty else { throw BotRemoteGrantError.busy }
    let id = UUID()
    changingConnection = id
    return id
  }
  func endConnectionChange(_ id: UUID) {
    if changingConnection == id { changingConnection = nil }
  }
}

public enum BotRemoteGrantError: Error {
  case invalid, needsLocal, changedConnection, cleanupPending, busy
}

@MainActor public final class BotRemoteGrantModel: ObservableObject, Identifiable {
  public let id = UUID()
  public let botID: String
  public let botTitle: String
  @Published public private(set) var configuration: BotRemoteConfiguration?
  @Published public private(set) var machines: [MachineRow] = []
  @Published public private(set) var connectedAddress: String?
  @Published public private(set) var deploymentRead = false
  @Published public private(set) var busy = false
  @Published public private(set) var refreshing = false
  @Published public private(set) var message: String?
  @Published public private(set) var editingAlias: String?
  @Published public var selectedMachineID = ""
  @Published public var alias = ""
  @Published public var permissions: Set<RemoteToolPermission> = []
  private let port: any RemoteToolsPort
  private let helper: (any BotRemoteCredentialAccess)?
  private let vault: any MachineCredentialVault
  private let sharing: any BotRemoteSharingStore
  private let coordinator: BotRemoteAccessCoordinator
  private let directory: (MachineConnection) async throws -> [MachineRow]
  private var connection: MachineConnection?
  private var active = true
  private var revision = 0
  private var readRevision = 0
  public var canGrant: Bool {
    active && !busy && !refreshing && connection != nil && helper != nil
      && configuration?.helperAvailable == true && configuration?.cleanupPending == false
      && !permissions.isEmpty
      && machines.contains { $0.id == selectedMachineID && $0.machine.enabled }
  }
  public var canRevoke: Bool { active && !busy && configuration != nil }
  public var deploymentSummary: String {
    connectedAddress ?? (deploymentRead ? "尚未保存 Eagle 部署" : "已保存部署尚未读取")
  }
  public var needsHelper: Bool {
    configuration != nil && (helper == nil || configuration?.helperAvailable == false)
  }
  public var grantUnavailableReason: String? {
    if refreshing { return nil }
    guard let configuration else { return "尚未读取本机 Bot 授权，请刷新后重试。" }
    if configuration.cleanupPending { return "请先完成旧凭据清理，再添加或修改授权。" }
    if helper == nil || !configuration.helperAvailable {
      return "本机授权组件不可用。请使用包含组件的 App，并确认 Bot 服务已连接该组件。组件恢复后关闭并重新打开此面板；已有授权仍可撤销。"
    }
    if connection == nil { return "先在 Eagle 机器设置中连接部署；已有 Bot 授权仍可撤销。" }
    if machines.isEmpty { return "尚未取得可选机器，请检查部署连接后刷新机器目录。" }
    return nil
  }

  public init(
    botID: String, botTitle: String, port: any RemoteToolsPort,
    helper: (any BotRemoteCredentialAccess)?, vault: any MachineCredentialVault,
    sharing: any BotRemoteSharingStore, coordinator: BotRemoteAccessCoordinator,
    directory: @escaping (MachineConnection) async throws -> [MachineRow]
  ) {
    self.botID = botID
    self.botTitle = botTitle
    self.port = port
    self.helper = helper
    self.vault = vault
    self.sharing = sharing
    self.coordinator = coordinator
    self.directory = directory
  }
  public func load() async {
    guard active, !busy else { return }
    readRevision += 1
    let ticket = readRevision
    refreshing = true
    connection = nil
    connectedAddress = nil
    machines = []
    configuration = nil
    deploymentRead = false
    defer { if ticket == readRevision { refreshing = false } }
    var vaultError: (any Error)?
    do {
      connection = try vault.load()
      connectedAddress = connection?.origin.absoluteString
      deploymentRead = true
    } catch { vaultError = error }
    do {
      let current = try await port.read(botID: botID)
      guard active, ticket == readRevision else { return }
      configuration = current
      if let vaultError { throw vaultError }
      guard let connection else {
        message = "先在 Eagle 机器设置中连接部署；已有 Bot 授权仍可撤销。"
        return
      }
      let rows = try await directory(connection)
      guard active, ticket == readRevision, try vault.load() == connection else { return }
      machines = rows
      message = current.cleanupPending ? "授权更新未完成，仍有凭据待清理。" : nil
    } catch {
      if active, ticket == readRevision { message = Self.describe(error) }
    }
  }

  public func edit(_ target: BotRemoteTarget) {
    guard active, !busy, target.origin == connectedAddress else { return }
    editingAlias = target.alias
    alias = target.alias
    selectedMachineID = target.machineId
    permissions = Set(target.operations)
  }
  public func cancelEditing() {
    guard !busy else { return }
    editingAlias = nil
    alias = ""
    permissions = []
  }

  public func grant() async {
    guard active, !busy, !Task.isCancelled else { return }
    revision += 1
    readRevision += 1
    let ticket = revision
    busy = true
    refreshing = false
    message = nil
    var lease: UUID?
    defer {
      if let lease { coordinator.endGrant(lease) }
      if ticket == revision { busy = false }
    }
    do {
      guard let helper, let initial = configuration, initial.helperAvailable,
        !initial.cleanupPending, !permissions.isEmpty,
        machines.contains(where: { $0.id == selectedMachineID && $0.machine.enabled }),
        alias.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) == alias
          .startIndex..<alias.endIndex
      else { throw BotRemoteGrantError.invalid }
      lease = try coordinator.beginGrant(binding: initial.namespace + ":" + botID)
      let connection = try currentConnection(ticket)
      guard !connection.containsCredential(alias),
        !initial.targets.contains(where: { $0.alias == alias && $0.alias != editingAlias })
      else { throw BotRemoteGrantError.invalid }
      let binding = BotRemoteCredentialBinding(
        namespace: initial.namespace, botId: botID,
        credentialRef: UUID().uuidString, origin: connection.origin.absoluteString)
      var target = BotRemoteTarget(
        alias: alias, enabled: false, origin: binding.origin,
        machineId: selectedMachineID, credentialRef: binding.credentialRef,
        operations: RemoteToolPermission.allCases.filter { permissions.contains($0) })
      let targets = initial.targets.filter { $0.alias != editingAlias } + [target]
      try sharing.remember(origin: binding.origin)
      let reserved = try await port.save(botID: botID, revision: initial.revision, targets: targets)
      _ = try currentConnection(ticket)
      configuration = reserved
      guard !reserved.cleanupPending, reserved.targets.contains(target) else {
        throw BotRemoteGrantError.cleanupPending
      }
      try await helper.put(binding, connection: connection)
      _ = try currentConnection(ticket)
      target.enabled = true
      let enabled = reserved.targets.map { $0.credentialRef == binding.credentialRef ? target : $0 }
      let confirmed = try await port.save(
        botID: botID, revision: reserved.revision, targets: enabled)
      _ = try currentConnection(ticket)
      configuration = confirmed
      guard !confirmed.cleanupPending, confirmed.targets.contains(target) else {
        throw BotRemoteGrantError.cleanupPending
      }
      editingAlias = nil
      permissions = []
      alias = ""
      message = "已授权给此 Bot；远程工具组需要单独启用。"
    } catch { await recover(error, ticket: ticket) }
  }

  public func revoke(alias: String) async { await changeTargets(removing: alias) }
  public func retryCleanup() async { await changeTargets(removing: nil) }
  private func changeTargets(removing alias: String?) async {
    guard active, !busy, !Task.isCancelled, let current = configuration else { return }
    revision += 1
    readRevision += 1
    let ticket = revision
    busy = true
    refreshing = false
    message = nil
    var lease: UUID?
    defer {
      if let lease { coordinator.endGrant(lease) }
      if ticket == revision { busy = false }
    }
    do {
      lease = try coordinator.beginGrant(binding: current.namespace + ":" + botID)
      let updated = try await port.save(
        botID: botID, revision: current.revision,
        targets: current.targets.filter { $0.alias != alias })
      guard active, ticket == revision else { return }
      configuration = updated
      message = updated.cleanupPending ? "授权已更新，凭据清理未完成。" : "授权和凭据清理已确认。"
    } catch { await recover(error, ticket: ticket) }
  }
  private func currentConnection(_ ticket: Int) throws -> MachineConnection {
    try Task.checkCancellation()
    guard active, ticket == revision, let connection, try vault.load() == connection else {
      throw BotRemoteGrantError.changedConnection
    }
    return connection
  }
  private func recover(_ error: any Error, ticket: Int) async {
    guard active, ticket == revision else { return }
    let actual = try? await port.read(botID: botID)
    guard active, ticket == revision else { return }
    configuration = actual
    message =
      actual?.cleanupPending == true
      ? "授权更新未完成，仍有凭据待清理；请重试清理。" : Self.describe(error)
  }
  public func invalidate() {
    active = false
    revision += 1
    readRevision += 1
    busy = false
    refreshing = false
  }
  static func describe(_ error: any Error) -> String {
    switch error {
    case RemoteToolsError.authentication: return "Bot 服务拒绝本机凭据，请重新连接 Bot 服务。"
    case RemoteToolsError.conflict: return "授权已更新，请刷新后确认；未使用旧版本重试。"
    case MachineAccessError.authentication: return "机器目录拒绝部署凭据，请在机器设置中重新连接；已有 Bot 授权仍可撤销。"
    case MachineAccessError.keychain: return "无法读取已保存部署的钥匙串，请在此 Mac 解锁后重试；已有 Bot 授权仍可撤销。"
    case is MachineAccessError: return "无法读取机器目录，请检查部署地址和网络后刷新；已有 Bot 授权仍可撤销。"
    case RemoteToolsError.invalid, BotRemoteGrantError.invalid: return "请选择机器、有效短名称和至少一项能力。"
    case BotRemoteGrantError.changedConnection: return "已保存的部署已改变；未继续授权，请重新打开此面板。"
    case BotRemoteGrantError.cleanupPending: return "凭据清理未完成，请刷新并重试清理。"
    case BotRemoteGrantError.busy: return "还有授权或部署更新正在进行，请完成后重试。"
    case LocalAgentError.unavailable, BotRemoteGrantError.needsLocal:
      return "本机授权组件或钥匙串不可用，请在此 Mac 处理后重试。"
    default: return "操作结果尚未确认，请刷新授权；未自动重复写入。"
    }
  }
}
