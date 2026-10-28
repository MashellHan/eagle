import Combine
import Foundation

@MainActor public protocol MachineConnectionSaving: AnyObject {
  func save(
    _ connection: MachineConnection, replacing old: MachineConnection?,
    stillCurrent: @escaping @MainActor () -> Bool
  ) async throws
  func requiresRevocation(origin: String) throws -> Bool
}

public enum MachineDirectoryPhase: Equatable {
  case unconfigured, loading, ready
  case failed(MachineAccessError)
}

public enum MachineObservation: Equatable, Sendable {
  case unknown, failed
  case observed(MachineExecutionStatus)
}

public struct MachineRow: Identifiable, Equatable, Sendable {
  public var machine: ManagedMachine
  public var observation: MachineObservation = .unknown
  public var id: String { machine.id }
  public var statusText: String {
    if !machine.enabled { return "已停用接入" }
    switch observation {
    case .unknown: return "执行状态尚未确认"
    case .failed: return "状态未知 · 无法读取执行状态"
    case .observed(let status):
      if !status.online {
        return status.observedAt == nil ? "已注册 · 执行端尚未连接" : "执行端离线"
      }
      guard let capabilities = status.capabilities else { return "执行能力尚未确认" }
      return capabilities.commands ? "执行端在线 · 已允许命令执行" : "执行端在线 · 命令执行已禁用"
    }
  }
  public var online: Bool {
    if case .observed(let status) = observation { return machine.enabled && status.online }
    return false
  }
}

@MainActor
public final class MachineSettingsModel: ObservableObject {
  @Published public var address = ""
  @Published public var credential = ""
  @Published public var useAccess = false
  @Published public var accessID = ""
  @Published public var accessSecret = ""
  @Published public private(set) var hasSavedCredential = false
  @Published public private(set) var phase: MachineDirectoryPhase = .unconfigured
  @Published public private(set) var machines: [MachineRow] = []
  @Published public private(set) var canIssue = false
  @Published public private(set) var busy = false
  @Published public private(set) var refreshing = false
  @Published public private(set) var credentialReadFailed = false
  @Published public private(set) var operationErrors: [String: String] = [:]
  @Published public private(set) var message: String?
  @Published public var renameTarget: String?
  @Published public var renameText = ""
  @Published public var revokeTarget: String?
  @Published public var agentAddress = ""
  @Published public var localMachineName = "Mac"
  @Published public var localCommands = false
  @Published public var commandDirectory = FileManager.default.homeDirectoryForCurrentUser.path
  @Published public private(set) var localState: LocalAgentState?
  @Published public private(set) var localBusy = false
  @Published public private(set) var localMessage: String?
  @Published public private(set) var localMachineID: String?
  @Published public private(set) var canRecoverLocal = false
  @Published public private(set) var savedNodePath: String?
  @Published public var editingConnection = false
  @Published public var editingLocal = false
  @Published public private(set) var canRepairLocal = false
  @Published public private(set) var requiresLocalRotation = false
  @Published public private(set) var localFileGrants: [LocalMachineFileGrant] = []
  @Published public private(set) var fileGrantMessage: String?
  private let vault: any MachineCredentialVault
  private let connectionWriter: (any MachineConnectionSaving)?
  private var agent: (any LocalAgentAccess)?
  private let nodeSelection: ((String) -> (any LocalAgentAccess)?)?
  private let saveNode: ((String) -> Void)?
  private let makeClient: (MachineConnection) -> MachineHTTPClient
  private var connection: MachineConnection?
  private var revision = 0
  private var localStatusRevision = 0
  private var readRevision = 0
  private var loaded = false
  private var active = true

  public var connectedAddress: String? { connection?.origin.absoluteString }
  public var canManage: Bool { active && phase == .ready && !busy && !localBusy }
  public var localAgentAvailable: Bool { agent != nil }
  public var allowsNodeSelection: Bool { nodeSelection != nil }
  public var connectionSaveTitle: String {
    guard let connection, connection != (try? draftConnection()), let connectionWriter else {
      return "保存并连接"
    }
    return (try? connectionWriter.requiresRevocation(origin: connection.origin.absoluteString))
      == false
      ? "保存并连接" : "撤销旧 Bot 授权并保存连接"
  }

  public func refreshFileGrants() async { await fileControl() }
  public func addFileGrant(path: String) async { await fileControl(path: path) }
  public func removeFileGrant(id: String) async { await fileControl(revoking: id) }
  private func fileControl(path: String? = nil, revoking: String? = nil) async {
    guard active, !localBusy else { return }
    guard let connection, let agent else {
      fileGrantMessage = LocalAgentError.unavailable.localizedDescription
      return
    }
    guard path == nil || phase == .ready else {
      fileGrantMessage = "请先连接部署，再添加目录授权；已有授权仍可在本机撤销"
      return
    }
    let ticket = revision
    localStatusRevision += 1
    localBusy = true
    fileGrantMessage = nil
    defer { if ticket == revision { localBusy = false } }
    do {
      let identity = try await agent.identity()
      guard ticket == revision, active else { return }
      guard path == nil || phase == .ready else {
        throw LocalAgentError.unavailable
      }
      guard identity.configured, identity.ownerOrigin == connection.origin.absoluteString else {
        throw LocalAgentError.deploymentMismatch
      }
      if let path {
        guard !connection.containsCredential(path) else { throw LocalAgentError.invalidResponse }
        let name = URL(fileURLWithPath: path).lastPathComponent
        try await agent.grantDirectory(path: path, name: name.isEmpty ? "目录" : name)
      }
      if let revoking { try await agent.revokeDirectory(id: revoking) }
      guard ticket == revision else { return }
      let grants = try await agent.fileGrants()
      guard ticket == revision else { return }
      guard
        !grants.contains(where: {
          [$0.id, $0.generation, $0.root, $0.name].contains(where: connection.containsCredential)
        })
      else { throw LocalAgentError.invalidResponse }
      localFileGrants = grants
      localMachineID = identity.machineId
      fileGrantMessage = path != nil ? "目录已授权" : revoking != nil ? "授权已撤销" : nil
    } catch {
      if ticket == revision {
        localFileGrants = []
        fileGrantMessage = (error as? LocalAgentError ?? .unavailable).localizedDescription
      }
    }
  }
  public func pluginConnection(id: String) -> MachineConnection? {
    guard canManage, machines.contains(where: { $0.id == id && $0.machine.enabled }) else {
      return nil
    }
    return connection
  }
  public func pluginAuthenticationFailed(_ attempted: MachineConnection) {
    if active && connection == attempted { show(MachineAccessError.authentication) }
  }

  public func readLocalConfiguration() async {
    guard active, !localBusy, let connection, let agent else { return }
    let ticket = revision
    localStatusRevision += 1
    localBusy = true
    defer { if ticket == revision { localBusy = false } }
    do {
      let identity = try await agent.identity()
      guard ticket == revision else { return }
      guard identity.configured,
        identity.ownerOrigin == nil || identity.ownerOrigin == connection.origin.absoluteString,
        let address = identity.url, let directory = identity.workingDirectory,
        let commands = identity.commands
      else { throw LocalAgentError.deploymentMismatch }
      requiresLocalRotation = identity.ownerOrigin == nil
      agentAddress = requiresLocalRotation ? "" : address
      commandDirectory = directory
      localCommands = commands
      localMachineID = identity.machineId
      canRepairLocal = true
      editingLocal = true
      localMessage =
        requiresLocalRotation
        ? "此手动配置尚未绑定管理部署。现有接入地址为 \(address)；请核对并填入该地址，再明确重新签发并绑定。旧凭据将立即失效。"
        : "修改后保存将停止并重新启动此本机服务；机器身份保持不变。"
    } catch {
      if ticket == revision {
        localMessage = (error as? LocalAgentError ?? .unavailable).localizedDescription
      }
    }
  }

  public func activate() { active = true }

  public func invalidate() {
    active = false
    revision += 1
    busy = false
    localBusy = false
    renameTarget = nil
    revokeTarget = nil
  }

  public init(
    vault: any MachineCredentialVault = KeychainMachineCredentials(),
    connectionWriter: (any MachineConnectionSaving)? = nil,
    agent: (any LocalAgentAccess)? = nil,
    nodeSelection: ((String) -> (any LocalAgentAccess)?)? = nil,
    saveNode: ((String) -> Void)? = nil,
    savedNodePath: String? = nil,
    client: @escaping (MachineConnection) -> MachineHTTPClient = {
      MachineHTTPClient(connection: $0)
    }
  ) {
    self.vault = vault
    self.connectionWriter = connectionWriter
    self.agent = agent
    self.nodeSelection = nodeSelection
    self.saveNode = saveNode
    self.savedNodePath = savedNodePath
    self.makeClient = client
  }

  public func selectNode(_ path: String) async {
    guard active, !localBusy, let candidate = nodeSelection?(path) else {
      localMessage = LocalAgentError.unavailable.localizedDescription
      return
    }
    let ticket = revision
    localStatusRevision += 1
    localBusy = true
    defer { if ticket == revision { localBusy = false } }
    do {
      let state = try await candidate.control("status")
      guard ticket == revision else { return }
      saveNode?(path)
      savedNodePath = path
      agent = candidate
      localState = state
      localMessage = "Node 路径已验证并保存"
    } catch {
      if ticket == revision {
        localMessage = (error as? LocalAgentError ?? .unavailable).localizedDescription
      }
    }
  }

  public func refreshLocal() async {
    guard active, !localBusy, let agent else { return }
    let ticket = revision
    localStatusRevision += 1
    let statusTicket = localStatusRevision
    do {
      let state = try await agent.control("status")
      if ticket == revision && statusTicket == localStatusRevision { localState = state }
    } catch {
      if ticket == revision && statusTicket == localStatusRevision {
        localState = nil
        localMessage = (error as? LocalAgentError ?? .unavailable).localizedDescription
      }
    }
  }

  private struct AgentConfiguration: Encodable {
    struct Execution: Encodable {
      let commands: Bool
      let workingDirectory: String
    }
    let url: String
    let ownerOrigin: String
    let token: String
    let machineId: String
    let machineName: String
    let execution: Execution
  }
  private struct AgentConfigurationPatch: Encodable {
    let machineId: String
    let ownerOrigin: String
    let url: String
    let token: String?
    let execution: AgentConfiguration.Execution
  }

  public func enableLocal(rotate: Bool = false, repair: Bool = false) async {
    guard active, !busy, !localBusy, phase == .ready, canIssue, let connection, let agent else {
      return
    }
    let ticket = revision
    localStatusRevision += 1
    localBusy = true
    localMessage = nil
    defer { if ticket == revision { localBusy = false } }
    do {
      if localCommands {
        var isDirectory: ObjCBool = false
        guard commandDirectory.hasPrefix("/"),
          FileManager.default.fileExists(atPath: commandDirectory, isDirectory: &isDirectory),
          isDirectory.boolValue
        else { throw LocalAgentError.invalidDirectory }
      }
      let identity = try await agent.identity()
      guard ticket == revision else { return }
      localMachineID = identity.machineId
      canRepairLocal = identity.configured
      requiresLocalRotation = identity.configured && identity.ownerOrigin == nil
      if identity.configured {
        let expectedOwner = connection.origin.absoluteString
        guard
          identity.ownerOrigin == expectedOwner
            || (identity.ownerOrigin == nil && repair && rotate),
          let savedURL = identity.url
        else { throw LocalAgentError.deploymentMismatch }
        if requiresLocalRotation && agentAddress.isEmpty {
          throw LocalAgentError.deploymentMismatch
        }
        if agentAddress.isEmpty { agentAddress = savedURL }
        let selected = try MachineConnection(
          address: agentAddress, ownerToken: String(repeating: "x", count: 32))
        guard selected.origin.absoluteString == savedURL else {
          throw LocalAgentError.deploymentMismatch
        }
        if repair {
          let state = try await agent.control("status")
          guard ticket == revision else { return }
          if state.installed { localState = try await agent.control("stop") }
          guard ticket == revision else { return }
          let issued =
            try await rotate ? makeClient(connection).rotate(id: identity.machineId) : nil
          guard ticket == revision else { return }
          let patch = AgentConfigurationPatch(
            machineId: identity.machineId,
            ownerOrigin: expectedOwner, url: savedURL, token: issued?.token,
            execution: .init(commands: localCommands, workingDirectory: commandDirectory))
          try await agent.reconfigure(JSONEncoder().encode(patch))
        }
      }
      if !identity.configured {
        let ingress = try MachineConnection(
          address: agentAddress, ownerToken: String(repeating: "x", count: 32))
        let client = makeClient(connection)
        let credential =
          try await rotate
          ? client.rotate(id: identity.machineId)
          : client.create(id: identity.machineId, name: localMachineName)
        guard ticket == revision else { return }
        let config = AgentConfiguration(
          url: ingress.origin.absoluteString, ownerOrigin: connection.origin.absoluteString,
          token: credential.token,
          machineId: credential.machine.id, machineName: credential.machine.name,
          execution: .init(commands: localCommands, workingDirectory: commandDirectory))
        try await agent.initialize(JSONEncoder().encode(config))
      }
      guard ticket == revision else { return }
      _ = try await agent.control("install")
      guard ticket == revision else { return }
      let state = try await agent.control("start")
      guard ticket == revision else { return }
      localState = state
      canRecoverLocal = false
      canRepairLocal = true
      requiresLocalRotation = false
      editingLocal = false
      localMessage = state.running == true ? "本机服务已运行；云端在线状态仍以机器列表为准" : "已提交启动，请重新读取服务状态"
      await refresh()
    } catch {
      var failure = error
      var registered = false
      if (error as? MachineAccessError) == .server(409), let id = localMachineID {
        do {
          registered = try await makeClient(connection).directory().machines.contains {
            $0.id == id
          }
        } catch { failure = error }
      }
      if ticket == revision {
        canRecoverLocal = registered
        if (failure as? MachineAccessError) == .authentication { show(failure) }
        localMessage =
          canRecoverLocal
          ? "此本机 ID 已在云端注册，但本机配置未完成。可重新签发凭据恢复接入；旧机器凭据将立即失效。"
          : (failure as? MachineAccessError)?.localizedDescription
            ?? (failure as? LocalAgentError ?? .unavailable).localizedDescription
      }
    }
  }

  public func controlLocal(_ action: String) async {
    guard active, !localBusy, ["start", "stop"].contains(action), let agent else { return }
    let ticket = revision
    localStatusRevision += 1
    localBusy = true
    localMessage = nil
    defer { if ticket == revision { localBusy = false } }
    do {
      if action == "start" {
        guard !busy, let connection, phase != .failed(.authentication) else {
          throw LocalAgentError.deploymentMismatch
        }
        let identity = try await agent.identity()
        guard ticket == revision else { return }
        guard identity.configured, identity.ownerOrigin == connection.origin.absoluteString,
          phase != .failed(.authentication)
        else { throw LocalAgentError.deploymentMismatch }
      }
      let state = try await agent.control(action)
      guard ticket == revision else { return }
      localState = state
      localMessage =
        action == "stop"
        ? "本机服务已停用；在途操作结果仍需核对"
        : "已提交启动；云端在线状态仍以机器列表为准"
    } catch {
      if ticket == revision {
        localMessage = (error as? LocalAgentError ?? .unavailable).localizedDescription
      }
    }
  }
  public func load() async {
    guard active, !loaded else { return }
    do {
      let saved = try vault.load()
      loaded = true
      credentialReadFailed = false
      guard let saved else { return }
      connection = saved
      address = saved.origin.absoluteString
      useAccess = saved.accessClientID != nil
      hasSavedCredential = true
      await refresh()
    } catch {
      credentialReadFailed = true
      message = "无法读取已保存连接，请解锁钥匙串后重新读取。"
    }
  }

  private func draftConnection() throws -> MachineConnection {
    let candidate = try MachineConnection(
      address: address,
      ownerToken: credential.isEmpty ? String(repeating: "x", count: 32) : credential)
    let saved = connection?.origin == candidate.origin ? connection : nil
    let token = credential.isEmpty ? saved?.ownerToken ?? "" : credential
    let keepAccess = useAccess && accessID.isEmpty && accessSecret.isEmpty
    let clientID = useAccess ? (keepAccess ? saved?.accessClientID : accessID) : nil
    let clientSecret = useAccess ? (keepAccess ? saved?.accessClientSecret : accessSecret) : nil
    guard !useAccess || (clientID != nil && clientSecret != nil) else {
      throw MachineAccessError.invalidCredential
    }
    return try MachineConnection(
      address: address, ownerToken: token,
      accessClientID: clientID, accessClientSecret: clientSecret
    )
  }

  private func begin() -> Int {
    revision += 1
    busy = true
    message = nil
    return revision
  }

  private func show(_ error: any Error) {
    let failure = error as? MachineAccessError ?? .unavailable
    message = failure.localizedDescription
    if failure == .authentication {
      readRevision += 1
      phase = .failed(failure)
      machines = machines.map { MachineRow(machine: $0.machine, observation: .unknown) }
    }
  }

  public func testConnection() async {
    guard active, !localBusy else { return }
    let ticket = begin()
    defer { if ticket == revision { busy = false } }
    do {
      let candidate = try draftConnection()
      _ = try await makeClient(candidate).directory()
      guard ticket == revision, candidate == (try? draftConnection()) else { return }
      message = "连接验证通过；保存后接入此部署"
    } catch { if ticket == revision { show(error) } }
  }

  public func saveAndConnect() async {
    guard active, !localBusy else { return }
    let ticket = begin()
    defer { if ticket == revision { busy = false } }
    do {
      let candidate = try draftConnection()
      let client = makeClient(candidate)
      let directory = try await client.directory()
      guard ticket == revision, candidate == (try? draftConnection()) else { return }
      if let connectionWriter {
        do {
          try await connectionWriter.save(
            candidate, replacing: connection,
            stillCurrent: {
              self.active && ticket == self.revision && candidate == (try? self.draftConnection())
            })
        } catch {
          if ticket == revision {
            message = "连接未更换。请核对旧 Bot 授权和凭据清理结果，再保存重试。"
          }
          return
        }
      } else {
        try vault.save(candidate)
      }
      guard active, ticket == revision else { return }
      if connection?.origin != candidate.origin {
        agentAddress = ""
        canRecoverLocal = false
        localMachineID = nil
        canRepairLocal = false
        requiresLocalRotation = false
        editingLocal = false
        localFileGrants = []
        fileGrantMessage = nil
      }
      connection = candidate
      address = candidate.origin.absoluteString
      credential = ""
      accessID = ""
      accessSecret = ""
      hasSavedCredential = true
      editingConnection = false
      operationErrors = [:]
      apply(directory)
      message = "已保存并连接"
      await observations(client, ticket: ticket, readTicket: readRevision)
    } catch { if ticket == revision { show(error) } }
  }

  public func refresh() async {
    guard active, !busy, !refreshing, renameTarget == nil, revokeTarget == nil, let connection
    else { return }
    let ticket = revision
    let readTicket = readRevision
    refreshing = true
    if phase != .ready { phase = .loading }
    defer { refreshing = false }
    do {
      let client = makeClient(connection)
      let directory = try await client.directory()
      guard ticket == revision, readTicket == readRevision else { return }
      apply(directory)
      await observations(client, ticket: ticket, readTicket: readTicket)
    } catch {
      guard ticket == revision, readTicket == readRevision else { return }
      phase = .failed(error as? MachineAccessError ?? .unavailable)
      machines = machines.map { MachineRow(machine: $0.machine, observation: .unknown) }
      show(error)
    }
  }

  private func apply(_ directory: MachineDirectory) {
    machines = directory.machines.map { MachineRow(machine: $0) }
    canIssue = directory.canIssue
    phase = .ready
  }

  private func observations(_ client: MachineHTTPClient, ticket: Int, readTicket: Int) async {
    let ids = machines.filter { $0.machine.enabled }.map(\.id)
    await withTaskGroup(of: (String, Result<MachineExecutionStatus, MachineAccessError>).self) {
      group in
      for id in ids {
        group.addTask {
          do { return (id, .success(try await client.status(id: id))) } catch {
            return (id, .failure(error as? MachineAccessError ?? .unavailable))
          }
        }
      }
      for await (id, result) in group {
        guard ticket == revision, readTicket == readRevision else {
          group.cancelAll()
          return
        }
        if case .failure(.authentication) = result {
          group.cancelAll()
          show(MachineAccessError.authentication)
          return
        }
        guard let index = machines.firstIndex(where: { $0.id == id }) else { continue }
        switch result {
        case .success(let status): machines[index].observation = .observed(status)
        case .failure: machines[index].observation = .failed
        }
      }
    }
  }

  public func rename(id: String) async {
    guard canManage, let connection else { return }
    let ticket = begin()
    operationErrors[id] = nil
    defer { if ticket == revision { busy = false } }
    do {
      let machine = try await makeClient(connection).rename(id: id, name: renameText)
      guard ticket == revision, let index = machines.firstIndex(where: { $0.id == id }) else {
        return
      }
      machines[index].machine = machine
      renameTarget = nil
      renameText = ""
    } catch {
      if ticket == revision {
        operationErrors[id] = (error as? MachineAccessError ?? .unavailable).localizedDescription
        show(error)
      }
    }
  }

  public func revoke(id: String) async {
    guard canManage, let connection else { return }
    let ticket = begin()
    operationErrors[id] = nil
    defer { if ticket == revision { busy = false } }
    do {
      let machine = try await makeClient(connection).revoke(id: id)
      guard ticket == revision, let index = machines.firstIndex(where: { $0.id == id }) else {
        return
      }
      machines[index] = MachineRow(machine: machine)
      revokeTarget = nil
    } catch {
      if ticket == revision {
        operationErrors[id] = (error as? MachineAccessError ?? .unavailable).localizedDescription
        show(error)
      }
    }
  }
}
