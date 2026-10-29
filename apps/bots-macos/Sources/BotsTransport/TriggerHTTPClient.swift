import BotsCore
import Foundation

/// The trigger detail and switch over HTTP (docs/bots/PROTOCOL.md, "Triggers"). Every call
/// carries the daemon bearer; a 401 fails closed instead of retrying.
public final class TriggerHTTPClient: TriggerPort, @unchecked Sendable {
  private let baseURL: URL
  private let token: String
  private let session: URLSession

  public init(baseURL: URL, token: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  public func list(botId: String) async throws -> [TriggerDetail] {
    var components = URLComponents(
      url: baseURL.appendingPathComponent("v1/triggers"), resolvingAgainstBaseURL: false)
    components?.queryItems = [URLQueryItem(name: "botId", value: botId)]
    guard let url = components?.url else { throw TriggerHTTPError.invalidURL }
    struct Payload: Decodable {
      let triggers: [Entry]
    }
    let payload = try await send(url, method: "GET", body: nil, as: Payload.self)
    return payload.triggers.map(\.detail)
  }

  public func setEnabled(
    botId: String, triggerId: String, enabled: Bool
  ) async throws -> TriggerDetail {
    let url = baseURL.appendingPathComponent("v1/triggers/\(botId)/\(triggerId)")
    struct Payload: Decodable {
      let trigger: Entry
    }
    let payload = try await send(
      url, method: "PATCH", body: try JSONEncoder().encode(Switch(enabled: enabled)),
      as: Payload.self)
    return payload.trigger.detail
  }

  /// The daemon's entry: the summary a client already renders, plus what HTTP adds.
  private struct Entry: Decodable {
    let id: String
    let kind: TriggerSummary.Kind
    let name: String
    let enabled: Bool
    let schedule: TriggerSummary.Schedule?
    let counters: TriggerSummary.Counters?
    let lastFiredAt: String?
    let lastSkipped: TriggerSummary.Skipped?
    let prompt: String?
    let endpoint: String?

    var detail: TriggerDetail {
      TriggerDetail(
        summary: TriggerSummary(
          id: id,
          kind: kind,
          name: name,
          enabled: enabled,
          schedule: schedule,
          counters: counters ?? TriggerSummary.Counters(),
          lastFiredAt: lastFiredAt,
          lastSkipped: lastSkipped
        ),
        prompt: prompt ?? "",
        endpoint: endpoint
      )
    }
  }

  private struct Switch: Encodable {
    let enabled: Bool
  }

  private func send<T: Decodable>(
    _ url: URL, method: String, body: Data?, as: T.Type
  ) async throws -> T {
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "content-type") }
    request.httpBody = body
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw TriggerHTTPError.transport }
    if http.statusCode == 401 { throw TriggerHTTPError.unauthorized }
    guard (200..<300).contains(http.statusCode) else {
      throw TriggerHTTPError.refused(status: http.statusCode)
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
}

public enum TriggerHTTPError: Error, Equatable, Sendable {
  case invalidURL
  case transport
  case unauthorized
  case refused(status: Int)
}
