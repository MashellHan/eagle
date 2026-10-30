import BotsCore
import Foundation

/// A bot's exchanges with other bots over HTTP (docs/bots/TRIGGERS.md §10): the list the
/// transcript folds into one row, and the round trip a person opens. Owner-scoped by the daemon;
/// a 401 or 404 fails closed instead of retrying.
public final class PeerHTTPClient: PeerPort, @unchecked Sendable {
  private let baseURL: URL
  private let token: String
  private let session: URLSession

  public init(baseURL: URL, token: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  public func list(botId: String) async throws -> [PeerExchangeSummary] {
    let url = baseURL.appendingPathComponent("v1/bots/\(botId)/exchanges")
    struct Payload: Decodable { let exchanges: [Entry] }
    return try await send(url, as: Payload.self).exchanges.map(\.summary)
  }

  public func detail(botId: String, exchangeId: String) async throws -> PeerExchangeDetail {
    let url = baseURL.appendingPathComponent("v1/bots/\(botId)/exchanges/\(exchangeId)")
    struct Payload: Decodable { let exchange: Detail }
    return try await send(url, as: Payload.self).exchange.value
  }

  private struct Participant: Decodable {
    let id: String
    let title: String
  }

  private struct Entry: Decodable {
    let id: String
    let participants: [Participant]
    let count: Int
    let status: String
    let startedAt: String
    let updatedAt: String?

    var summary: PeerExchangeSummary {
      PeerExchangeSummary(
        id: id,
        participants: participants.map { PeerExchangeParticipant(id: $0.id, title: $0.title) },
        count: count,
        status: status,
        startedAt: startedAt,
        updatedAt: updatedAt ?? startedAt
      )
    }
  }

  private struct Turn: Decodable {
    let requestId: String
    let fromBotId: String
    let toBotId: String
    let at: String
    let text: String?
    let answer: String?
  }

  private struct Detail: Decodable {
    let id: String
    let participants: [Participant]
    let status: String
    let startedAt: String
    let turns: [Turn]

    var value: PeerExchangeDetail {
      PeerExchangeDetail(
        id: id,
        participants: participants.map { PeerExchangeParticipant(id: $0.id, title: $0.title) },
        status: status,
        startedAt: startedAt,
        messages: turns.map {
          PeerExchangeMessage(
            id: $0.requestId,
            fromBotId: $0.fromBotId,
            toBotId: $0.toBotId,
            at: $0.at,
            text: $0.text ?? "",
            answer: $0.answer
          )
        }
      )
    }
  }

  private func send<T: Decodable>(_ url: URL, as: T.Type) async throws -> T {
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw PeerHTTPError.unreachable }
    switch http.statusCode {
    case 200: break
    case 401: throw PeerHTTPError.unauthorized
    case 404: throw PeerHTTPError.notFound
    default: throw PeerHTTPError.unreachable
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
}

public enum PeerHTTPError: Error, Equatable {
  case unauthorized
  case notFound
  case unreachable
}
