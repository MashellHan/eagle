import Darwin
import Foundation

public struct LocalAgentState: Codable, Equatable, Sendable {
  public let label: String
  public let installed: Bool
  public let loaded: Bool
  public let disabled: Bool?
  public let running: Bool?
  public let pid: Int?
  public let lastExit: Int?
}

public struct LocalAgentIdentity: Decodable, Sendable {
  public let machineId: String
  public let configured: Bool
  public let ownerOrigin: String?
  public let url: String?
  public let commands: Bool?
  public let workingDirectory: String?
  public init(
    machineId: String, configured: Bool, ownerOrigin: String? = nil, url: String? = nil,
    commands: Bool? = nil, workingDirectory: String? = nil
  ) {
    self.machineId = machineId
    self.configured = configured
    self.ownerOrigin = ownerOrigin
    self.url = url
    self.commands = commands
    self.workingDirectory = workingDirectory
  }
}

public protocol LocalAgentAccess: Sendable {
  func identity() async throws -> LocalAgentIdentity
  func initialize(_ configuration: Data) async throws
  func reconfigure(_ configuration: Data) async throws
  func control(_ action: String) async throws -> LocalAgentState
  func fileGrants() async throws -> [LocalMachineFileGrant]
  func grantDirectory(path: String, name: String) async throws
  func revokeDirectory(id: String) async throws
}

extension LocalAgentAccess {
  public func reconfigure(_ configuration: Data) async throws { throw LocalAgentError.unavailable }
  public func fileGrants() async throws -> [LocalMachineFileGrant] {
    throw LocalAgentError.unavailable
  }
  public func grantDirectory(path: String, name: String) async throws {
    throw LocalAgentError.unavailable
  }
  public func revokeDirectory(id: String) async throws { throw LocalAgentError.unavailable }
}

public struct LocalMachineFileGrant: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let generation: String
  public let name: String
  public let root: String
}

public enum LocalAgentError: Error, Equatable, LocalizedError {
  case unavailable, invalidResponse, timedOut, invalidDirectory, deploymentMismatch
  case failed(Int32)
  public var errorDescription: String? {
    switch self {
    case .unavailable: return "本机需要 Node.js 24+ 和已安装的 Eagle Agent"
    case .invalidResponse: return "无法识别本机执行服务响应"
    case .timedOut: return "本机服务操作超时，请重新读取状态后核对"
    case .invalidDirectory: return "请选择本机存在的绝对目录；工作目录不限制命令的系统权限"
    case .deploymentMismatch: return "现有本机配置属于另一部署或接入地址未绑定，不能在当前部署下自动复用"
    case .failed(let code): return "本机服务操作失败（\(code)），请检查本机配置及私有日志"
    }
  }
}

public struct LocalAgentService: LocalAgentAccess {
  public let node: URL
  public let cli: URL
  public let config: URL
  public init(node: URL, cli: URL, config: URL) {
    self.node = node
    self.cli = cli
    self.config = config
  }
  public static func discover(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    nodePreference: String? = nil,
    resources: URL? = Bundle.main.resourceURL,
    home: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> LocalAgentService? {
    let candidates: [String]
    if let explicit = environment["EAGLE_AGENT_NODE"] {
      candidates = [explicit]
    } else if let nodePreference {
      candidates = [nodePreference]
    } else {
      candidates =
        [
          "/opt/homebrew/bin/node", "/usr/local/bin/node",
          home.appendingPathComponent(".local/bin/node").path,
        ]
        + (environment["PATH"] ?? "").split(separator: ":").map { "\($0)/node" }
    }
    guard
      let node = candidates.first(where: {
        $0.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0)
      }),
      let cli = environment["EAGLE_AGENT_CLI"]
        ?? resources?.appendingPathComponent(
          "Agent/node_modules/@nocoo/eagle-agent/dist/agent/cli.js"
        ).path,
      cli.hasPrefix("/"), FileManager.default.fileExists(atPath: cli)
    else { return nil }
    let config =
      environment["EAGLE_CONFIG"]
      ?? home.appendingPathComponent(".config/eagle/executor/agent.json").path
    guard config.hasPrefix("/") else { return nil }
    return LocalAgentService(
      node: URL(fileURLWithPath: node), cli: URL(fileURLWithPath: cli),
      config: URL(fileURLWithPath: config))
  }
  public func initialize(_ configuration: Data) async throws {
    guard configuration.count <= 65_536 else { throw LocalAgentError.invalidResponse }
    _ = try await run(["init"], input: configuration)
  }
  public func reconfigure(_ configuration: Data) async throws {
    guard configuration.count <= 65_536 else { throw LocalAgentError.invalidResponse }
    _ = try await run(["reconfigure"], input: configuration)
  }
  public func identity() async throws -> LocalAgentIdentity {
    let data = try await run(["identity"])
    guard let value = try? JSONDecoder().decode(LocalAgentIdentity.self, from: data),
      value.machineId.range(of: #"^[a-z0-9][a-z0-9_-]{0,79}$"#, options: .regularExpression)
        == value.machineId.startIndex..<value.machineId.endIndex
    else { throw LocalAgentError.invalidResponse }
    return value
  }
  public func control(_ action: String) async throws -> LocalAgentState {
    guard ["install", "start", "stop", "status"].contains(action) else {
      throw LocalAgentError.invalidResponse
    }
    let data = try await run(["service", action])
    guard let state = try? JSONDecoder().decode(LocalAgentState.self, from: data),
      state.label.range(
        of: #"^ai\.hexly\.eagle\.agent\.[0-9a-f]{24}$"#, options: .regularExpression)
        == state.label.startIndex..<state.label.endIndex,
      state.pid.map({ $0 > 0 }) ?? true
    else { throw LocalAgentError.invalidResponse }
    return state
  }

  public func fileGrants() async throws -> [LocalMachineFileGrant] {
    struct Response: Decodable { let grants: [LocalMachineFileGrant] }
    let data = try await run(["files", "list"])
    guard let result = try? JSONDecoder().decode(Response.self, from: data),
      result.grants.count <= 32,
      Set(result.grants.map(\.id)).count == result.grants.count,
      Set(result.grants.map(\.root)).count == result.grants.count,
      result.grants.allSatisfy({
        validGrantID($0.id) && validGrantID($0.generation) && $0.root.hasPrefix("/")
          && $0.root.utf8.count <= 4096 && !$0.root.contains("\0")
          && (1...120).contains($0.name.utf16.count)
      })
    else { throw LocalAgentError.invalidResponse }
    return result.grants
  }
  public func grantDirectory(path: String, name: String) async throws {
    guard path.hasPrefix("/"), path.utf8.count <= 4096, !path.contains("\0"),
      (1...120).contains(name.utf16.count)
    else { throw LocalAgentError.invalidResponse }
    _ = try await run(
      ["files", "grant"], input: JSONEncoder().encode(["root": path, "name": name]))
  }
  public func revokeDirectory(id: String) async throws {
    guard validGrantID(id) else { throw LocalAgentError.invalidResponse }
    _ = try await run(["files", "revoke"], input: JSONEncoder().encode(["id": id]))
  }
  private func validGrantID(_ id: String) -> Bool {
    id.range(of: "^[a-zA-Z0-9_-]{1,80}$", options: .regularExpression) == id
      .startIndex..<id.endIndex
  }

  private func run(_ arguments: [String], input: Data = Data()) async throws -> Data {
    try await Task.detached(priority: .userInitiated) {
      let version = String(
        decoding: try runBlocking(["--version"], input: Data(), direct: true), as: UTF8.self)
      guard version.hasPrefix("v"),
        let major = Int(version.dropFirst().split(separator: ".").first ?? ""), major >= 24
      else { throw LocalAgentError.unavailable }
      return try runBlocking(arguments, input: input)
    }.value
  }

  private func runBlocking(_ arguments: [String], input: Data, direct: Bool = false) throws -> Data
  {
    guard FileManager.default.isExecutableFile(atPath: node.path),
      FileManager.default.fileExists(atPath: cli.path)
    else { throw LocalAgentError.unavailable }
    return try LocalPrivateProcess.runBlocking(
      executable: node, arguments: direct ? arguments : [cli.path] + arguments,
      environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "EAGLE_CONFIG": config.path],
      input: input)
  }
}

/// A bounded private pipe shared by the Agent CLI and the credential helper.
enum LocalPrivateProcess {
  static func runBlocking(
    executable: URL, arguments: [String], environment: [String: String], input: Data
  ) throws -> Data {
    guard input.count <= 65_536 else { throw LocalAgentError.invalidResponse }
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = environment
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    let output = AgentProcessOutput()
    let errorDrain = AgentProcessOutput(retain: false)
    let exited = DispatchSemaphore(value: 0)
    process.standardInput = stdin
    process.standardOutput = stdout
    process.standardError = stderr
    process.terminationHandler = { _ in exited.signal() }
    stdout.fileHandleForReading.readabilityHandler = { handle in
      output.append(handle.availableData)
    }
    stderr.fileHandleForReading.readabilityHandler = { handle in
      errorDrain.append(handle.availableData)
    }
    defer {
      stdout.fileHandleForReading.readabilityHandler = nil
      stderr.fileHandleForReading.readabilityHandler = nil
      try? stdout.fileHandleForReading.close()
      try? stderr.fileHandleForReading.close()
    }
    do { try process.run() } catch { throw LocalAgentError.unavailable }
    try? stdout.fileHandleForWriting.close()
    try? stderr.fileHandleForWriting.close()
    try? stdin.fileHandleForReading.close()
    DispatchQueue.global(qos: .userInitiated).async {
      try? stdin.fileHandleForWriting.write(contentsOf: input)
      try? stdin.fileHandleForWriting.close()
    }
    if exited.wait(timeout: .now() + 15) == .timedOut {
      if process.isRunning { process.terminate() }
      if exited.wait(timeout: .now() + 1) == .timedOut, process.isRunning {
        kill(process.processIdentifier, SIGKILL)
        _ = exited.wait(timeout: .now() + 1)
      }
      throw LocalAgentError.timedOut
    }
    guard process.terminationReason == .exit, process.terminationStatus == 0 else {
      throw LocalAgentError.failed(process.terminationStatus)
    }
    for _ in 0..<30 {
      if output.finished && errorDrain.finished { break }
      Thread.sleep(forTimeInterval: 0.01)
    }
    guard output.finished, !output.overflow else { throw LocalAgentError.invalidResponse }
    return output.bytes
  }
}

private final class AgentProcessOutput: @unchecked Sendable {
  private let lock = NSLock()
  private let retain: Bool
  private var data = Data()
  private var ended = false
  private var exceeded = false
  init(retain: Bool = true) { self.retain = retain }
  func append(_ chunk: Data) {
    lock.withLock {
      if chunk.isEmpty {
        ended = true
        return
      }
      guard retain else { return }
      let remaining = max(0, 65_536 - data.count)
      data.append(chunk.prefix(remaining))
      exceeded = exceeded || chunk.count > remaining
    }
  }
  var finished: Bool { lock.withLock { ended } }
  var overflow: Bool { lock.withLock { exceeded } }
  var bytes: Data { lock.withLock { data } }
}
