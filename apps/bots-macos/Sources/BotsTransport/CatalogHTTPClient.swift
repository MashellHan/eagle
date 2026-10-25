import BotsCore
import Foundation

/// The catalog over HTTP (docs/bots/PROTOCOL.md, "HTTP endpoints"). Every call carries the
/// bearer token; a 401 is an authentication failure, never a retry.
public final class CatalogHTTPClient: CatalogPort {
  private let baseURL: URL
  private let token: String
  private let session: URLSession

  public init(baseURL: URL, token: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  public func load() async throws -> [BotSummary] {
    struct Payload: Decodable { let bots: [BotSummary] }
    return try await request(path: "/v1/bots", method: "GET", body: nil, as: Payload.self).bots
  }

  public func create(
    title: String,
    label: String?,
    appearance: BotAppearance
  ) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    var body: [String: Any] = [
      "title": title,
      "appearance": ["shape": appearance.shape.rawValue, "tint": appearance.tint.rawValue],
    ]
    if let label, !label.isEmpty { body["label"] = label }
    return try await request(path: "/v1/bots", method: "POST", body: body, as: Payload.self).bot
  }

  public func rename(id: String, title: String) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    return try await request(
      path: "/v1/bots/\(id)",
      method: "PATCH",
      body: ["title": title],
      as: Payload.self
    ).bot
  }

  public func delete(id: String) async throws {
    _ = try await raw(path: "/v1/bots/\(id)", method: "DELETE", body: nil)
  }

  /// The daemon pushes catalog changes on the conversation socket; HTTP has no push.
  public func catalogEvents() -> AsyncStream<[BotSummary]> {
    AsyncStream { continuation in
      continuation.finish()
    }
  }

  private struct ErrorPayload: Decodable {
    struct Body: Decodable {
      let kind: ErrorKind
      let message: String
    }
    let error: Body
  }

  private func request<T: Decodable>(
    path: String,
    method: String,
    body: [String: Any]?,
    as: T.Type
  ) async throws -> T {
    let data = try await raw(path: path, method: method, body: body)
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw ClientError("the daemon answered something this client cannot read")
    }
  }

  private func raw(path: String, method: String, body: [String: Any]?) async throws -> Data {
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw ClientError("the daemon is not reachable: \(error.localizedDescription)")
    }
    guard let http = response as? HTTPURLResponse else {
      throw ClientError("the daemon answered without an HTTP response")
    }
    guard (200..<300).contains(http.statusCode) else {
      if http.statusCode == 401 {
        throw ClientError("the daemon rejected the token")
      }
      if let payload = try? JSONDecoder().decode(ErrorPayload.self, from: data) {
        throw ClientError(payload.error.message)
      }
      throw ClientError("the daemon answered \(http.statusCode)")
    }
    return data
  }
}
