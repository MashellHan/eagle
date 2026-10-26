import BotsCore
import Combine
import EagleDesign
import Foundation

actor BotsTranscriptProjector {
  func project(_ state: ConversationState) throws -> [TranscriptEntry] {
    try Task.checkCancellation()
    return BotsPresenter().transcript(for: state)
  }
}

@MainActor
final class BotsTranscriptViewModel: ObservableObject {
  @Published private(set) var entries: [TranscriptEntry] = []
  private let projector = BotsTranscriptProjector()
  private var input: ConversationState?
  private var projection: Task<Void, Never>?

  func update(_ state: ConversationState) {
    guard input != state else { return }
    if input?.botId != state.botId { clear() }
    input = state
    projection?.cancel()
    projection = Task { [weak self, projector] in
      guard let next = try? await projector.project(state), !Task.isCancelled else { return }
      if self?.entries != next { self?.entries = next }
    }
  }

  func clear() {
    projection?.cancel()
    input = nil
    if !entries.isEmpty { entries = [] }
  }

  deinit { projection?.cancel() }
}
