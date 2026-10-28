import Foundation

public struct MachineOperationRecord: Codable, Equatable, Sendable {
  public let id: String
  public let state: String
  public let stdout: String
  public let stderr: String
  public let exitCode: Int?
}

public struct MachineHerdrOperation: Encodable, Equatable, Sendable {
  public let id: String
  public let machineId: String
  public let tool = "herdr.setup"
  public let action: String
  public let session: String?
  public let enabled: Bool?
  public let expectedRevision: String?
  public let timeoutMs: Int?
  public init(
    id: String, machineId: String, action: String, session: String? = nil,
    enabled: Bool? = nil, expectedRevision: String? = nil, timeoutMs: Int? = nil
  ) {
    self.id = id
    self.machineId = machineId
    self.action = action
    self.session = session
    self.enabled = enabled
    self.expectedRevision = expectedRevision
    self.timeoutMs = timeoutMs
  }
}

public enum MachineExecutionError: Error, Equatable, LocalizedError {
  case offline, notFound, disabled, busy, conflict, denied, unknown, invalid
  public var errorDescription: String? {
    switch self {
    case .offline: return "目标机器离线，未改用其他机器"
    case .notFound: return "此机器尚未记录该操作，请核对原操作 ID"
    case .disabled: return "目标机器未启用此能力"
    case .busy: return "目标机器正忙，请稍后查询"
    case .conflict: return "操作 ID 与原请求不一致"
    case .denied: return "目标机器已撤销此操作的授权"
    case .unknown: return "结果尚未确认；请查询原操作 ID，不要重复发起"
    case .invalid: return "无法识别机器执行响应"
    }
  }
}

public protocol MachineExecutionAccess: Sendable {
  func run(_ operation: MachineHerdrOperation) async throws -> MachineOperationRecord
  func get(machineID: String, operationID: String) async throws -> MachineOperationRecord
  func cancel(machineID: String, operationID: String) async throws -> Bool
}

public final class MachineExecutionClient: MachineExecutionAccess, Sendable {
  public let connection: MachineConnection
  public init(connection: MachineConnection) { self.connection = connection }
  public func run(_ operation: MachineHerdrOperation) async throws -> MachineOperationRecord {
    guard valid(operation.id), valid(operation.machineId, machine: true),
      ["probe", "install", "configure", "create_session", "verify", "disable"].contains(
        operation.action),
      operation.timeoutMs.map({ (1...120_000).contains($0) }) ?? true
    else { throw MachineExecutionError.invalid }
    let changing = ["configure", "create_session"].contains(operation.action)
    guard
      changing
        ? operation.session.map({ valid($0, limit: 64) }) == true && operation.enabled != nil
          && operation.expectedRevision.map({ valid($0, limit: 64) }) == true
        : operation.session == nil && operation.enabled == nil
          && (operation.action == "disable"
            ? operation.expectedRevision.map({ valid($0, limit: 64) }) == true
            : operation.expectedRevision == nil)
    else { throw MachineExecutionError.invalid }
    let data = try JSONEncoder().encode(operation)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw MachineExecutionError.invalid
    }
    let result = try await exchange(
      machineID: operation.machineId, operationID: operation.id,
      body: ["type": "run", "operation": object],
      timeout: (operation.timeoutMs ?? (operation.action == "install" ? 120_000 : 15_000)) + 5000)
    guard case .record(let value) = result else { throw MachineExecutionError.invalid }
    return value
  }
  public func get(machineID: String, operationID: String) async throws -> MachineOperationRecord {
    let result = try await exchange(
      machineID: machineID, operationID: operationID,
      body: ["type": "get", "operationId": operationID], timeout: 5000)
    guard case .record(let value) = result else { throw MachineExecutionError.invalid }
    return value
  }
  public func cancel(machineID: String, operationID: String) async throws -> Bool {
    let result = try await exchange(
      machineID: machineID, operationID: operationID,
      body: ["type": "cancel", "operationId": operationID], timeout: 5000)
    guard case .cancelled(let value) = result else { throw MachineExecutionError.invalid }
    return value
  }
  enum Reply: Sendable {
    case record(MachineOperationRecord)
    case cancelled(Bool)
  }
  private func valid(_ value: String, machine: Bool = false, limit: Int = 120) -> Bool {
    let pattern = machine ? "^[a-z0-9][a-z0-9_-]{0,79}$" : "^[a-zA-Z0-9_-]{1,\(limit)}$"
    return value.range(of: pattern, options: .regularExpression) == value
      .startIndex..<value.endIndex
      && !connection.containsCredential(value)
  }
  private func secret(_ value: Any) -> Bool {
    if let text = value as? String { return connection.containsCredential(text) }
    if let array = value as? [Any] { return array.contains(where: secret) }
    if let object = value as? [String: Any] {
      return object.contains { connection.containsCredential($0.key) || secret($0.value) }
    }
    return false
  }
  func decode(
    _ text: String, requestID: String, operationID: String, machineID: String,
    cancelling: Bool
  ) throws -> Reply? {
    guard text.utf8.count <= 512 * 1024, let data = text.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], !secret(object),
      let type = object["type"] as? String
    else { throw MachineExecutionError.invalid }
    if type == "pong", Set(object.keys) == ["type"] { return nil }
    if type == "status" {
      guard
        Set(object.keys) == [
          "type", "machineId", "online", "observedAt", "agentVersion", "capabilities",
        ],
        let value = try? JSONDecoder().decode(MachineExecutionStatus.self, from: data),
        value.machineId == machineID
      else { throw MachineExecutionError.invalid }
      try value.validate(connection: connection, id: machineID)
      return nil
    }
    guard object["requestId"] as? String == requestID else { throw MachineExecutionError.invalid }
    if type == "error" {
      guard Set(object.keys) == ["type", "requestId", "operationId", "code"],
        object["operationId"] as? String == operationID
      else { throw MachineExecutionError.invalid }
      let code = object["code"] as? String
      let error: MachineExecutionError
      switch code {
      case "offline": error = .offline
      case "not_found": error = .notFound
      case "disabled": error = .disabled
      case "busy": error = .busy
      case "conflict": error = .conflict
      case "denied": error = .denied
      case "unavailable": error = .unknown
      default: error = .invalid
      }
      throw error
    }
    if type == "cancel-ack", cancelling {
      guard Set(object.keys) == ["type", "requestId", "operationId", "requested"],
        object["operationId"] as? String == operationID,
        let requested = object["requested"] as? NSNumber,
        CFGetTypeID(requested) == CFBooleanGetTypeID()
      else { throw MachineExecutionError.invalid }
      return .cancelled(requested.boolValue)
    }
    guard !cancelling, type == "result", Set(object.keys) == ["type", "requestId", "operation"],
      let raw = object["operation"] as? [String: Any],
      Set(raw.keys) == ["id", "state", "stdout", "stderr", "exitCode"],
      let data = try? JSONSerialization.data(withJSONObject: raw),
      let result = try? JSONDecoder().decode(MachineOperationRecord.self, from: data),
      result.id == operationID,
      ["running", "succeeded", "failed", "cancelled", "unknown"].contains(result.state),
      result.stdout.utf8.count + result.stderr.utf8.count <= 65_536,
      result.exitCode.map({ (0...255).contains($0) }) ?? true,
      !["running", "cancelled", "unknown"].contains(result.state) || result.exitCode == nil,
      result.state != "succeeded" || result.exitCode == nil || result.exitCode == 0
    else { throw MachineExecutionError.invalid }
    return .record(result)
  }
  private func exchange(
    machineID: String, operationID: String, body: [String: Any], timeout: Int
  ) async throws -> Reply {
    guard valid(machineID, machine: true), valid(operationID), !secret(body) else {
      throw MachineExecutionError.invalid
    }
    let requestID = UUID().uuidString
    var envelope = body
    envelope["requestId"] = requestID
    let encoded = try JSONSerialization.data(withJSONObject: envelope)
    guard encoded.count <= 16_384, let payload = String(data: encoded, encoding: .utf8) else {
      throw MachineExecutionError.invalid
    }
    let cancelling = body["type"] as? String == "cancel"
    var parts = URLComponents(url: connection.origin, resolvingAgainstBaseURL: false)!
    parts.scheme = parts.scheme == "https" ? "wss" : "ws"
    parts.path = "/api/v1/execution"
    parts.queryItems = [URLQueryItem(name: "machine", value: machineID)]
    var request = URLRequest(url: parts.url!)
    request.setValue("Bearer \(connection.ownerToken)", forHTTPHeaderField: "Authorization")
    request.setValue(connection.accessClientID, forHTTPHeaderField: "CF-Access-Client-Id")
    request.setValue(connection.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = Double(timeout) / 1000
    let session = URLSession(
      configuration: config, delegate: MachineRedirectPolicy(), delegateQueue: nil)
    let socket = session.webSocketTask(with: request)
    socket.maximumMessageSize = 512 * 1024
    defer {
      socket.cancel(with: .goingAway, reason: nil)
      session.invalidateAndCancel()
    }
    socket.resume()
    let completion = MachineReplyCompletion {
      socket.cancel()
      session.invalidateAndCancel()
    }
    do {
      return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          completion.install(continuation)
          let receiving = Task {
            do {
              guard completion.waiting, !Task.isCancelled else { return }
              try await socket.send(.string(payload))
              while completion.waiting && !Task.isCancelled {
                let message = try await socket.receive()
                guard case .string(let text) = message else { throw MachineExecutionError.invalid }
                if let reply = try self.decode(
                  text, requestID: requestID, operationID: operationID,
                  machineID: machineID, cancelling: cancelling)
                {
                  completion.finish(.success(reply))
                  return
                }
              }
            } catch {
              if [401, 403].contains((socket.response as? HTTPURLResponse)?.statusCode ?? 0)
                || socket.closeCode.rawValue == 4001
              {
                completion.finish(.failure(MachineAccessError.authentication))
              } else {
                completion.finish(.failure(error))
              }
            }
          }
          completion.track(receiving)
          completion.track(
            Task {
              do {
                try await Task.sleep(for: .milliseconds(timeout))
                completion.finish(.failure(MachineExecutionError.unknown))
              } catch {}
            })
          completion.track(
            Task {
              do {
                while completion.waiting && !Task.isCancelled {
                  try await Task.sleep(for: .seconds(10))
                  try await socket.send(.string("{\"type\":\"ping\"}"))
                }
              } catch {}
            })
        }
      } onCancel: {
        completion.finish(.failure(MachineExecutionError.unknown))
      }
    } catch let error as MachineExecutionError { throw error } catch let error as MachineAccessError
    { throw error } catch {
      if [401, 403].contains((socket.response as? HTTPURLResponse)?.statusCode ?? 0)
        || socket.closeCode.rawValue == 4001
      {
        throw MachineAccessError.authentication
      }
      throw MachineExecutionError.unknown
    }
  }
}

/// A URLSession receive can ignore cancellation until its peer closes. Complete
/// the caller once on its own deadline; cancelled IO never holds a task-group
/// join or publishes a late result. Every worker is cancelled at that same edge.
private final class MachineReplyCompletion: @unchecked Sendable {
  typealias Reply = MachineExecutionClient.Reply
  private let lock = NSLock()
  private var result: Result<Reply, any Error>?
  private var continuation: CheckedContinuation<Reply, any Error>?
  private var workers: [Task<Void, Never>] = []
  private let close: @Sendable () -> Void
  init(close: @escaping @Sendable () -> Void) { self.close = close }
  var waiting: Bool {
    lock.lock()
    defer { lock.unlock() }
    return result == nil
  }
  func install(_ continuation: CheckedContinuation<Reply, any Error>) {
    lock.lock()
    let result = result
    if result == nil { self.continuation = continuation }
    lock.unlock()
    if let result { continuation.resume(with: result) }
  }
  func track(_ worker: Task<Void, Never>) {
    lock.lock()
    let ended = result != nil
    if !ended { workers.append(worker) }
    lock.unlock()
    if ended { worker.cancel() }
  }
  func finish(_ result: Result<Reply, any Error>) {
    lock.lock()
    guard self.result == nil else {
      lock.unlock()
      return
    }
    self.result = result
    let continuation = continuation
    self.continuation = nil
    let workers = workers
    self.workers = []
    lock.unlock()
    for worker in workers { worker.cancel() }
    close()
    continuation?.resume(with: result)
  }
}
