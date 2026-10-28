import Foundation

public enum MachineAccessError: Error, Equatable, LocalizedError {
  case invalidAddress, invalidCredential, authentication, invalidResponse, unavailable
  case server(Int)
  case keychain(Int32)

  public var errorDescription: String? {
    switch self {
    case .invalidAddress: return "请输入 HTTPS 部署地址；本地测试可使用 loopback HTTP 地址"
    case .invalidCredential: return "请提供此部署的凭据，Access 凭据须成对填写"
    case .authentication: return "部署凭据验证失败"
    case .invalidResponse: return "云端响应无法识别"
    case .unavailable: return "无法连接云端，请检查地址和网络"
    case .server(let status): return "云端请求失败（\(status)）"
    case .keychain(let status): return "连接设置未保存，无法访问钥匙串（\(status)）"
    }
  }
}

public struct MachineConnection: Codable, Equatable, Sendable {
  public let origin: URL
  public let ownerToken: String
  public let accessClientID: String?
  public let accessClientSecret: String?

  public init(
    address: String, ownerToken: String,
    accessClientID: String? = nil, accessClientSecret: String? = nil
  ) throws {
    guard
      var parts = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
      scheme == "https"
        || (scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      parts.path.isEmpty || parts.path == "/",
      parts.port == nil || (1...65535).contains(parts.port!),
      !address.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else { throw MachineAccessError.invalidAddress }
    func validHeader(_ value: String, minimum: Int = 1) -> Bool {
      (minimum...8192).contains(value.utf8.count)
        && !value.unicodeScalars.contains(where: {
          CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0)
        })
    }
    guard validHeader(ownerToken, minimum: 32),
      (accessClientID == nil && accessClientSecret == nil)
        || (accessClientID.map { validHeader($0) } == true
          && accessClientSecret.map { validHeader($0) } == true)
    else { throw MachineAccessError.invalidCredential }
    parts.scheme = scheme
    parts.host = host
    parts.path = ""
    if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) {
      parts.port = nil
    }
    guard let origin = parts.url else { throw MachineAccessError.invalidAddress }
    self.origin = origin
    self.ownerToken = ownerToken
    self.accessClientID = accessClientID
    self.accessClientSecret = accessClientSecret
  }

  public init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      address: values.decode(URL.self, forKey: .origin).absoluteString,
      ownerToken: values.decode(String.self, forKey: .ownerToken),
      accessClientID: values.decodeIfPresent(String.self, forKey: .accessClientID),
      accessClientSecret: values.decodeIfPresent(String.self, forKey: .accessClientSecret)
    )
  }

  func containsCredential(_ value: String) -> Bool {
    [ownerToken, accessClientID, accessClientSecret].compactMap { $0 }.contains {
      value.contains($0)
    }
  }
}

public struct ManagedMachine: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let enabled: Bool
}

public struct MachineDirectory: Decodable, Sendable {
  public let machines: [ManagedMachine]
  public let canIssue: Bool
}

public struct MachineIssuedCredential: Decodable, Sendable {
  public let machine: ManagedMachine
  public let token: String
}

public struct MachineExecutionStatus: Decodable, Equatable, Sendable {
  public struct Capabilities: Decodable, Equatable, Sendable {
    public let commands: Bool
    public let files: MachineFileCapabilities?
    public let herdr: MachineHerdrStatus?
    public init(
      commands: Bool, files: MachineFileCapabilities? = nil, herdr: MachineHerdrStatus? = nil
    ) {
      self.commands = commands
      self.files = files
      self.herdr = herdr
    }
  }
  public let machineId: String
  public let online: Bool
  public let observedAt: String?
  public let agentVersion: String?
  public let capabilities: Capabilities?
  func validate(connection: MachineConnection, id: String) throws {
    guard machineId == id,
      !online || (capabilities != nil && observedAt != nil && agentVersion != nil),
      agentVersion.map({ !$0.isEmpty && $0.count <= 80 && !connection.containsCredential($0) })
        ?? true,
      observedAt.map({ MachineHTTPClient.validTimestamp($0) && !connection.containsCredential($0) })
        ?? true
    else { throw MachineAccessError.invalidResponse }
    try capabilities?.files?.validate(connection: connection)
    try capabilities?.herdr?.validate(connection: connection)
  }
}

public struct MachineFileCapabilities: Decodable, Equatable, Sendable {
  public struct Grant: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let generation: String
    public let name: String
    public let available: Bool
  }
  public let state: String
  public let grants: [Grant]
  func validate(connection: MachineConnection) throws {
    guard ["ready", "unknown"].contains(state), grants.count <= 32,
      Set(grants.map(\.id)).count == grants.count,
      grants.allSatisfy({ grant in
        machineIdentifier(grant.id, maximum: 80)
          && machineIdentifier(grant.generation, maximum: 128)
          && (1...120).contains(grant.name.utf16.count)
          && ![grant.id, grant.generation, grant.name].contains(
            where: connection.containsCredential)
      })
    else { throw MachineAccessError.invalidResponse }
  }
}

func machineIdentifier(_ value: String, maximum: Int) -> Bool {
  value.range(of: "^[a-zA-Z0-9_-]{1,\(maximum)}$", options: .regularExpression)
    == value.startIndex..<value.endIndex
}

public struct MachineHerdrStatus: Codable, Equatable, Sendable {
  public struct Session: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let running: Bool
    public var id: String { name }
  }
  public struct Checks: Codable, Equatable, Sendable {
    public let cli: Bool?
    public let server: Bool?
    public let session: Bool?
    public let tools: Bool?
  }
  public let state: String
  public let installed: Bool?
  public let version: String?
  public let enabled: Bool
  public let session: String?
  public let revision: String
  public let sessions: [Session]
  public let checks: Checks
  public let observedAt: String?
  public var label: String {
    switch state {
    case "ready": return "可用"
    case "not_installed": return "未安装"
    case "disabled": return session == nil ? "未选择会话" : "已配置 · 未启用"
    case "needs_local_setup": return "会话未就绪"
    case "unavailable": return "连接不可用"
    default: return "未知"
    }
  }
  func validate(connection: MachineConnection) throws {
    guard
      ["unknown", "not_installed", "disabled", "needs_local_setup", "unavailable", "ready"]
        .contains(state),
      machineIdentifier(revision, maximum: 64), sessions.count <= 64,
      Set(sessions.map(\.name)).count == sessions.count,
      sessions.allSatisfy({
        machineIdentifier($0.name, maximum: 64) && !$0.name.hasPrefix("-")
          && !$0.name.hasPrefix("_")
      }),
      session.map({ machineIdentifier($0, maximum: 64) && !$0.hasPrefix("-") && !$0.hasPrefix("_") }
      ) ?? true,
      version.map({ !$0.isEmpty && $0.count <= 80 }) ?? true,
      observedAt.map(MachineHTTPClient.validTimestamp) ?? true,
      !([state, revision] + [session, version, observedAt].compactMap { $0 } + sessions.map(\.name))
        .contains(where: connection.containsCredential),
      state != "ready"
        || (enabled && installed == true && version != nil && observedAt != nil && session != nil
          && checks.cli == true && checks.server == true && checks.session == true
          && checks.tools == true
          && sessions.contains { $0.name == session && $0.running })
    else { throw MachineAccessError.invalidResponse }
  }
}

final class MachineRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

public final class MachineHTTPClient: Sendable {
  public let connection: MachineConnection
  private let session: URLSession
  public convenience init(connection: MachineConnection) {
    self.init(connection: connection, configuration: .ephemeral)
  }

  init(connection: MachineConnection, configuration: URLSessionConfiguration) {
    self.connection = connection
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 12
    configuration.timeoutIntervalForResource = 15
    session = URLSession(
      configuration: configuration, delegate: MachineRedirectPolicy(), delegateQueue: nil)
  }

  deinit { session.invalidateAndCancel() }

  private func validID(_ id: String) -> Bool {
    !connection.containsCredential(id)
      && id.range(of: "^[a-z0-9][a-z0-9_-]{0,79}$", options: .regularExpression)
        == id.startIndex..<id.endIndex
  }

  private func validate(_ machine: ManagedMachine) throws {
    guard validID(machine.id), (1...120).contains(machine.name.utf16.count),
      !connection.containsCredential(machine.name), !connection.containsCredential(machine.id)
    else { throw MachineAccessError.invalidResponse }
  }

  public func directory() async throws -> MachineDirectory {
    let result: MachineDirectory = try await request("/api/v1/machines")
    guard result.machines.count <= 1000,
      Set(result.machines.map(\.id)).count == result.machines.count
    else { throw MachineAccessError.invalidResponse }
    for machine in result.machines { try validate(machine) }
    return result
  }

  public func status(id: String) async throws -> MachineExecutionStatus {
    guard validID(id) else { throw MachineAccessError.invalidResponse }
    let result: MachineExecutionStatus = try await request(
      "/api/v1/execution/status", query: [URLQueryItem(name: "machine", value: id)])
    try result.validate(connection: connection, id: id)
    return result
  }

  static func validTimestamp(_ value: String) -> Bool {
    guard value.count <= 64,
      value.range(
        of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$"#,
        options: .regularExpression
      ) == value.startIndex..<value.endIndex
    else { return false }
    let dateText = String(value.prefix(10))
    let date = DateFormatter()
    date.locale = Locale(identifier: "en_US_POSIX")
    date.timeZone = TimeZone(secondsFromGMT: 0)
    date.dateFormat = "yyyy-MM-dd"
    date.isLenient = false
    guard let day = date.date(from: dateText), date.string(from: day) == dateText else {
      return false
    }
    let timestamp = ISO8601DateFormatter()
    timestamp.formatOptions =
      value.contains(".")
      ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
    return timestamp.date(from: value)?.timeIntervalSince1970.isFinite == true
  }

  private struct UpdatedMachine: Decodable { let machine: ManagedMachine }

  public func create(id: String, name: String) async throws -> MachineIssuedCredential {
    let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard validID(id), (1...120).contains(value.utf16.count), !connection.containsCredential(value)
    else { throw MachineAccessError.invalidResponse }
    let result: MachineIssuedCredential = try await request(
      "/api/v1/machines", body: ["id": id, "name": value])
    try validateIssued(result, id: id)
    guard result.machine.name == value else { throw MachineAccessError.invalidResponse }
    return result
  }

  public func rotate(id: String) async throws -> MachineIssuedCredential {
    guard validID(id) else { throw MachineAccessError.invalidResponse }
    let result: MachineIssuedCredential = try await request(
      "/api/v1/machines/\(id)/rotate", body: [:])
    try validateIssued(result, id: id)
    return result
  }

  private func validateIssued(_ result: MachineIssuedCredential, id: String) throws {
    try validate(result.machine)
    guard result.machine.id == id, result.machine.enabled,
      !connection.containsCredential(result.token),
      (try? MachineConnection(address: connection.origin.absoluteString, ownerToken: result.token))
        != nil
    else { throw MachineAccessError.invalidResponse }
  }

  public func rename(id: String, name: String) async throws -> ManagedMachine {
    let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard validID(id), (1...120).contains(value.utf16.count), !connection.containsCredential(value)
    else { throw MachineAccessError.invalidResponse }
    let result: UpdatedMachine = try await request(
      "/api/v1/machines/\(id)/rename", body: ["name": value])
    try validate(result.machine)
    guard result.machine.id == id && result.machine.name == value else {
      throw MachineAccessError.invalidResponse
    }
    return result.machine
  }

  public func revoke(id: String) async throws -> ManagedMachine {
    guard validID(id) else { throw MachineAccessError.invalidResponse }
    let result: UpdatedMachine = try await request("/api/v1/machines/\(id)/revoke", body: [:])
    try validate(result.machine)
    guard result.machine.id == id && !result.machine.enabled else {
      throw MachineAccessError.invalidResponse
    }
    return result.machine
  }

  private func request<T: Decodable>(
    _ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil
  ) async throws -> T {
    var parts = URLComponents(url: connection.origin, resolvingAgainstBaseURL: false)!
    parts.path = path
    if !query.isEmpty { parts.queryItems = query }
    var request = URLRequest(url: parts.url!)
    request.setValue("Bearer \(connection.ownerToken)", forHTTPHeaderField: "Authorization")
    request.setValue(connection.accessClientID, forHTTPHeaderField: "CF-Access-Client-Id")
    request.setValue(connection.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    do {
      let (bytes, response) = try await session.bytes(for: request)
      defer { bytes.task.cancel() }
      guard let http = response as? HTTPURLResponse else {
        throw MachineAccessError.invalidResponse
      }
      if [401, 403].contains(http.statusCode) { throw MachineAccessError.authentication }
      if (300..<400).contains(http.statusCode) { throw MachineAccessError.invalidResponse }
      guard (200..<300).contains(http.statusCode) else {
        throw MachineAccessError.server(http.statusCode)
      }
      guard http.mimeType == "application/json", http.expectedContentLength <= 1024 * 1024
      else { throw MachineAccessError.invalidResponse }
      var data = Data()
      for try await byte in bytes {
        guard data.count < 1024 * 1024 else { throw MachineAccessError.invalidResponse }
        data.append(byte)
      }
      do { return try JSONDecoder().decode(T.self, from: data) } catch {
        throw MachineAccessError.invalidResponse
      }
    } catch let error as MachineAccessError { throw error } catch {
      throw MachineAccessError.unavailable
    }
  }
}
