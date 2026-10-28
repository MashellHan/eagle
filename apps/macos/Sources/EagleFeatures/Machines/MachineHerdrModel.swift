import Combine
import Foundation

public struct MachineOperationReference: Codable, Equatable, Sendable {
  public let id: String
  public let action: String
  public let createdAt: Date
}

@MainActor public protocol MachineOperationStore: AnyObject {
  func load(origin: String, machine: String) throws -> MachineOperationReference?
  func save(_ reference: MachineOperationReference, origin: String, machine: String) throws
  func history(origin: String, machine: String) throws -> [MachineOperationReference]
  func archive(_ reference: MachineOperationReference, origin: String, machine: String) throws
}

@MainActor public final class MemoryMachineOperationStore: MachineOperationStore {
  private var values: [String: MachineOperationReference] = [:]
  private var archives: [String: [MachineOperationReference]] = [:]
  public init() {}
  public func load(origin: String, machine: String) throws -> MachineOperationReference? {
    values[origin + "|" + machine]
  }
  public func save(_ reference: MachineOperationReference, origin: String, machine: String) throws {
    values[origin + "|" + machine] = reference
  }
  public func history(origin: String, machine: String) throws -> [MachineOperationReference] {
    archives[origin + "|" + machine] ?? []
  }
  public func archive(
    _ reference: MachineOperationReference, origin: String, machine: String
  ) throws {
    let key = origin + "|" + machine
    guard values[key] == reference else { throw MachineExecutionError.conflict }
    var saved = archives[key] ?? []
    if !saved.contains(reference) { saved.append(reference) }
    guard saved.count <= 128 else { throw MachineExecutionError.busy }
    archives[key] = saved
    values[key] = nil
  }
}

@MainActor public final class DefaultsMachineOperationStore: MachineOperationStore {
  private let defaults: UserDefaults
  public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
  private func key(_ origin: String, _ machine: String) -> String {
    "eagle.machine-operation." + origin + "|" + machine
  }
  public func load(origin: String, machine: String) throws -> MachineOperationReference? {
    guard let stored = defaults.object(forKey: key(origin, machine)) else { return nil }
    guard let data = stored as? Data, data.count <= 2048 else {
      throw MachineExecutionError.invalid
    }
    return try JSONDecoder().decode(MachineOperationReference.self, from: data)
  }
  public func save(_ reference: MachineOperationReference, origin: String, machine: String) throws {
    defaults.set(try JSONEncoder().encode(reference), forKey: key(origin, machine))
    guard defaults.synchronize() else { throw MachineExecutionError.unknown }
  }
  public func history(origin: String, machine: String) throws -> [MachineOperationReference] {
    guard let data = defaults.data(forKey: key(origin, machine) + ".history") else { return [] }
    guard data.count <= 64 * 1024 else { throw MachineExecutionError.invalid }
    return try JSONDecoder().decode([MachineOperationReference].self, from: data)
  }
  public func archive(
    _ reference: MachineOperationReference, origin: String, machine: String
  ) throws {
    guard try load(origin: origin, machine: machine) == reference else {
      throw MachineExecutionError.conflict
    }
    var saved = try history(origin: origin, machine: machine)
    if !saved.contains(reference) { saved.append(reference) }
    let data = try JSONEncoder().encode(saved)
    guard saved.count <= 128, data.count <= 64 * 1024 else { throw MachineExecutionError.busy }
    defaults.set(data, forKey: key(origin, machine) + ".history")
    guard defaults.synchronize() else { throw MachineExecutionError.unknown }
    defaults.removeObject(forKey: key(origin, machine))
    guard defaults.synchronize() else { throw MachineExecutionError.unknown }
  }
}

@MainActor public final class MachineHerdrModel: ObservableObject, Identifiable {
  public nonisolated let id: String
  public let machine: ManagedMachine
  public let connection: MachineConnection
  @Published public private(set) var status: MachineHerdrStatus?
  @Published public private(set) var reference: MachineOperationReference?
  @Published public private(set) var record: MachineOperationRecord?
  @Published public private(set) var historical = false
  @Published public private(set) var savedReferences: [MachineOperationReference] = []
  @Published public private(set) var busy = false
  @Published public private(set) var message: String?
  @Published public var selectedSession = ""
  @Published public var newSession = ""
  @Published public var createNew = false
  @Published public var enabled = true
  private let store: any MachineOperationStore
  private let client: any MachineExecutionAccess
  private let authorized: () -> Bool
  private let authenticationFailed: () -> Void
  private var generation = 0
  private var active = true
  private var loaded = false
  private var notRecorded = false
  private var work: Task<MachineOperationRecord, any Error>?
  public init(
    machine: ManagedMachine, connection: MachineConnection, status: MachineHerdrStatus? = nil,
    store: any MachineOperationStore, client: (any MachineExecutionAccess)? = nil,
    authorized: @escaping () -> Bool = { true }, authenticationFailed: @escaping () -> Void = {}
  ) {
    self.id = machine.id
    self.machine = machine
    self.connection = connection
    self.status = status
    self.store = store
    self.client = client ?? MachineExecutionClient(connection: connection)
    self.authorized = authorized
    self.authenticationFailed = authenticationFailed
    selectedSession = status?.session ?? ""
    enabled = status?.enabled ?? true
  }
  public func activate() {
    if !active { status = nil }
    active = true
  }
  public var unresolved: Bool {
    reference != nil && !["succeeded", "failed", "cancelled"].contains(record?.state ?? "")
  }
  public var canStart: Bool { active && authorized() && !busy && !unresolved }
  public var canContinueAfterInspection: Bool {
    active && authorized() && !busy && (record?.state == "unknown" || notRecorded)
  }
  private func restore() throws {
    let current = try store.load(origin: connection.origin.absoluteString, machine: machine.id)
    if current != reference {
      record = nil
      historical = false
      notRecorded = false
    }
    reference = current
    savedReferences = try store.history(
      origin: connection.origin.absoluteString, machine: machine.id)
    for reference in savedReferences + (reference.map { [$0] } ?? []) {
      guard machineIdentifier(reference.id, maximum: 120),
        !connection.containsCredential(reference.id),
        ["probe", "install", "configure", "create_session", "verify", "disable"].contains(
          reference.action),
        reference.createdAt.timeIntervalSince1970.isFinite
      else { throw MachineExecutionError.invalid }
    }
    loaded = true
  }
  public func invalidate() {
    active = false
    generation += 1
    work?.cancel()
    work = nil
    busy = false
  }
  public func load() async {
    guard active, authorized(), !busy else { return }
    do {
      try restore()
      if reference != nil {
        await query()
      } else {
        await perform("probe")
      }
    } catch { show(error) }
  }
  public func perform(_ action: String) async {
    guard active, authorized(), !busy else { return }
    do {
      if !loaded { try restore() }
      let latest = try store.load(origin: connection.origin.absoluteString, machine: machine.id)
      if latest != reference {
        record = nil
        notRecorded = false
        try restore()
      }
    } catch {
      show(error)
      return
    }
    guard !unresolved else {
      message = "原操作尚未确认；请先查询原 ID，不会发起新操作"
      return
    }
    guard ["probe", "install", "configure", "create_session", "verify", "disable"].contains(action)
    else {
      show(MachineExecutionError.invalid)
      return
    }
    let changing = ["configure", "create_session"].contains(action)
    let selected = action == "create_session" ? newSession : selectedSession
    if changing
      && (!machineIdentifier(selected, maximum: 64) || selected.hasPrefix("-")
        || selected.hasPrefix("_"))
    {
      show(MachineExecutionError.invalid)
      return
    }
    if (changing || action == "disable") && status == nil {
      message = "请先检测当前配置"
      return
    }
    let reference = MachineOperationReference(
      id: UUID().uuidString, action: action, createdAt: Date())
    let operation = MachineHerdrOperation(
      id: reference.id, machineId: machine.id, action: action,
      session: changing ? selected : nil,
      enabled: changing ? (action == "create_session" ? true : enabled) : nil,
      expectedRevision: changing || action == "disable" ? status?.revision : nil)
    do {
      try store.save(reference, origin: connection.origin.absoluteString, machine: machine.id)
      self.reference = reference
      record = nil
      notRecorded = false
      await execute(operation)
    } catch { show(error) }
  }
  public func query() async {
    guard active, authorized(), !busy, reference != nil else { return }
    await execute(nil)
  }
  public func continueAfterInspection() {
    guard canContinueAfterInspection, let reference else { return }
    do {
      try store.archive(reference, origin: connection.origin.absoluteString, machine: machine.id)
      savedReferences = try store.history(
        origin: connection.origin.absoluteString, machine: machine.id)
      self.reference = nil
      record = nil
      notRecorded = false
      historical = false
      message = "原操作 ID 已保留；请先重新检测，再决定下一步。原操作不会重放。"
    } catch { show(error) }
  }
  public func querySaved(_ reference: MachineOperationReference) async {
    guard canStart, savedReferences.contains(reference) else { return }
    do {
      try restore()
      guard !unresolved else {
        message = "另一窗口的操作尚未确认；请先查询原 ID"
        return
      }
      try store.save(reference, origin: connection.origin.absoluteString, machine: machine.id)
      self.reference = reference
      record = nil
      notRecorded = false
      await query()
    } catch { show(error) }
  }
  private func execute(_ operation: MachineHerdrOperation?) async {
    guard let reference else { return }
    let ticket = generation
    busy = true
    message = nil
    let client = client
    let machineID = machine.id
    let task = Task {
      if let operation { return try await client.run(operation) }
      return try await client.get(machineID: machineID, operationID: reference.id)
    }
    work = task
    defer {
      if ticket == generation {
        busy = false
        work = nil
      }
    }
    do {
      let result = try await task.value
      guard ticket == generation, active, authorized() else { return }
      guard result.id == reference.id, !connection.containsCredential(result.stdout),
        !connection.containsCredential(result.stderr)
      else { throw MachineExecutionError.invalid }
      if operation != nil, result.state == "succeeded" {
        guard let data = result.stdout.data(using: .utf8),
          let current = try? JSONDecoder().decode(MachineHerdrStatus.self, from: data)
        else { throw MachineExecutionError.invalid }
        try current.validate(connection: connection)
        status = current
        if selectedSession.isEmpty || operation?.action == "create_session" {
          selectedSession = current.session ?? ""
        }
        if operation?.action == "create_session" {
          createNew = false
          newSession = ""
        }
        enabled = current.enabled
      }
      record = result
      notRecorded = false
      historical = operation == nil
      switch result.state {
      case "succeeded": message = historical ? "已读取历史结果；当前状态请重新检测" : "操作完成，状态来自本次实际检测"
      case "running": message = "操作仍在执行，请查询原操作 ID"
      case "unknown": message = "操作结果待确认，请查询并核对目标会话"
      case "cancelled": message = "操作在执行前已取消"
      default: message = "操作未完成；配置可能已更新，请检测后确认"
      }
    } catch {
      if ticket == generation && active {
        if operation == nil, error as? MachineExecutionError == .notFound { notRecorded = true }
        show(error)
      }
    }
  }
  public func cancel() async {
    guard active, authorized(), let reference else { return }
    let ticket = generation
    do {
      let requested = try await client.cancel(machineID: machine.id, operationID: reference.id)
      if active && ticket == generation {
        message = requested ? "已请求取消；已发生的操作不会回滚，请查询原 ID" : "没有可取消的在途操作，请查询原 ID"
      }
    } catch { if active && ticket == generation { show(error) } }
  }
  private func show(_ error: any Error) {
    if let access = error as? MachineAccessError {
      message = access.localizedDescription
      if access == .authentication { authenticationFailed() }
    } else {
      message = (error as? MachineExecutionError ?? .unknown).localizedDescription
    }
  }
}
