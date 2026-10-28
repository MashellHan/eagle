import BotsCore
import Foundation

public struct RemoteToolsHTTPClient: RemoteToolsPort, @unchecked Sendable {
  private let baseURL: URL
  private let token: String
  private let configuration: URLSessionConfiguration
  public init(
    baseURL: URL, token: String, configuration: URLSessionConfiguration = .ephemeral
  ) {
    self.baseURL = baseURL
    self.token = token
    self.configuration = configuration.copy() as! URLSessionConfiguration
  }
  public func botIDs() async throws -> [String] {
    struct Bot: Decodable { let id: String }
    struct Payload: Decodable { let bots: [Bot] }
    let payload: Payload = try await request(path: "v1/bots", limit: 262_144)
    let ids = payload.bots.map(\.id)
    guard ids.count <= 200, Set(ids).count == ids.count,
      ids.allSatisfy({ matches($0, "[A-Za-z0-9_-]{1,80}") })
    else { throw RemoteToolsError.invalid }
    return ids
  }
  public func read(botID: String) async throws -> BotRemoteConfiguration {
    guard matches(botID, "[A-Za-z0-9_-]{1,80}") else { throw RemoteToolsError.invalid }
    let payload: Payload = try await request(path: "v1/bots/\(botID)/remote-tools")
    return try checked(payload.remoteTools)
  }
  public func save(botID: String, revision: String, targets: [BotRemoteTarget]) async throws
    -> BotRemoteConfiguration
  {
    guard matches(botID, "[A-Za-z0-9_-]{1,80}"), matches(revision, "[A-Za-z0-9_-]{1,80}"),
      validTargets(targets)
    else { throw RemoteToolsError.invalid }
    struct Input: Encodable {
      let revision: String
      let targets: [BotRemoteTarget]
    }
    let body = try JSONEncoder().encode(Input(revision: revision, targets: targets))
    guard body.count <= 8192 else { throw RemoteToolsError.invalid }
    let payload: Payload = try await request(path: "v1/bots/\(botID)/remote-tools", body: body)
    return try checked(payload.remoteTools)
  }

  private struct Payload: Decodable { let remoteTools: BotRemoteConfiguration }
  private func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: "^\(pattern)$", options: .regularExpression) == value
      .startIndex..<value.endIndex
  }
  private func validTargets(_ targets: [BotRemoteTarget]) -> Bool {
    targets.count <= 8 && Set(targets.map(\.alias)).count == targets.count
      && Set(targets.map(\.credentialRef)).count == targets.count
      && targets.allSatisfy { target in
        matches(target.alias, "[A-Za-z0-9_-]{1,80}")
          && matches(target.machineId, "[a-z0-9][a-z0-9_-]{0,79}")
          && matches(target.credentialRef, "[A-Za-z0-9_-]{8,120}")
          && !target.operations.isEmpty && Set(target.operations).count == target.operations.count
          && validOrigin(target.origin)
      }
  }
  private func validOrigin(_ value: String) -> Bool {
    guard value.utf8.count <= 2048, let parts = URLComponents(string: value),
      let host = parts.host, host == host.lowercased(), parts.user == nil, parts.password == nil,
      parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
      parts.port.map({ (1...65535).contains($0) }) ?? true,
      parts.url?.absoluteString == value
    else { return false }
    return parts.scheme == "https" && parts.port != 443
      || parts.scheme == "http" && parts.port != 80
        && ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host)
  }
  private func checked(_ value: BotRemoteConfiguration) throws -> BotRemoteConfiguration {
    guard matches(value.namespace, "[a-f0-9]{64}"), matches(value.revision, "[A-Za-z0-9_-]{1,80}"),
      validTargets(value.targets)
    else { throw RemoteToolsError.invalid }
    return value
  }
  private func request<Value: Decodable>(
    path: String, body: Data? = nil, limit: Int = 65_536
  ) async throws -> Value {
    guard !path.contains(token), baseURL.scheme == "http", let host = baseURL.host,
      ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host),
      baseURL.user == nil, baseURL.password == nil, baseURL.query == nil, baseURL.fragment == nil,
      baseURL.path.isEmpty || baseURL.path == "/", (32...8192).contains(token.utf8.count),
      token.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil
    else { throw RemoteToolsError.invalid }
    if let body {
      guard let value = try? JSONSerialization.jsonObject(with: body), !containsCredential(value)
      else {
        throw RemoteToolsError.invalid
      }
    }
    let configuration = self.configuration.copy() as! URLSessionConfiguration
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 15
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    let session = URLSession(
      configuration: configuration, delegate: RemoteRedirectRefusal(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = body == nil ? "GET" : "PUT"
    request.httpBody = body
    request.timeoutInterval = 15
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    do {
      let (bytes, response) = try await session.bytes(for: request)
      guard let http = response as? HTTPURLResponse, http.url == request.url else {
        throw RemoteToolsError.invalid
      }
      switch http.statusCode {
      case 200: break
      case 401, 403: throw RemoteToolsError.authentication
      case 409: throw RemoteToolsError.conflict
      case 300..<400: throw RemoteToolsError.invalid
      default: throw RemoteToolsError.unavailable
      }
      guard
        http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("application/json")
          == true,
        http.expectedContentLength <= limit
      else { throw RemoteToolsError.invalid }
      var data = Data()
      for try await byte in bytes {
        guard data.count < limit else { throw RemoteToolsError.invalid }
        data.append(byte)
      }
      guard let decoded = try? JSONSerialization.jsonObject(with: data),
        !containsCredential(decoded),
        let value = try? JSONDecoder().decode(Value.self, from: data)
      else {
        throw RemoteToolsError.invalid
      }
      return value
    } catch let error as RemoteToolsError { throw error } catch {
      throw RemoteToolsError.unavailable
    }
  }
  private func containsCredential(_ value: Any) -> Bool {
    if let value = value as? String { return value.contains(token) }
    if let values = value as? [Any] { return values.contains(where: containsCredential) }
    if let values = value as? [String: Any] {
      return values.keys.contains { $0.contains(token) }
        || values.values.contains(where: containsCredential)
    }
    return false
  }
}

private final class RemoteRedirectRefusal: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
