import BotsCore
import Combine
import EagleDesign
import Foundation

actor BotsTranscriptProjector {
  private let renderer = MarkdownRenderer()
  private var prepared: [String: (text: String, blocks: [RenderedMarkdownBlock])] = [:]

  func project(
    _ state: ConversationState,
    exchanges: [PeerExchangeSummary],
    bots: [BotSummary]
  ) async throws -> BotsTranscriptProjection {
    try Task.checkCancellation()
    let entries = BotsPresenter().transcript(for: state, exchanges: exchanges, bots: bots)
    var next: [String: (text: String, blocks: [RenderedMarkdownBlock])] = [:]
    for entry in entries {
      switch entry {
      case .assistant(_, let blocks, _), .streamingAssistant(_, let blocks):
        let text = blocks.markdown
        if let cached = prepared[entry.id], cached.text == text {
          next[entry.id] = cached
        } else {
          next[entry.id] = (text, try await renderer.render(text))
        }
      default: break
      }
      try Task.checkCancellation()
    }
    prepared = next
    return BotsTranscriptProjection(entries: entries, markdown: next.mapValues(\.blocks))
  }
}

struct BotsTranscriptProjection: Sendable {
  let entries: [TranscriptEntry]
  let markdown: [String: [RenderedMarkdownBlock]]
}

@MainActor
final class BotsTranscriptViewModel: ObservableObject {
  @Published private(set) var entries: [TranscriptEntry] = []
  private(set) var markdown: [String: [RenderedMarkdownBlock]] = [:]
  private let projector = BotsTranscriptProjector()
  /// Everything the projection reads, so a change in any of it re-projects once.
  private struct Input: Equatable {
    let state: ConversationState
    let exchanges: [PeerExchangeSummary]
    let bots: [BotSummary]
  }

  private var input: Input?
  private var projection: Task<Void, Never>?

  func update(
    _ state: ConversationState, exchanges: [PeerExchangeSummary] = [], bots: [BotSummary] = []
  ) {
    let next = Input(state: state, exchanges: exchanges, bots: bots)
    guard input != next else { return }
    if input?.state.botId != state.botId { clear() }
    input = next
    projection?.cancel()
    projection = Task { [weak self, projector] in
      guard
        let next = try? await projector.project(state, exchanges: exchanges, bots: bots),
        !Task.isCancelled
      else { return }
      self?.markdown = next.markdown
      if self?.entries != next.entries { self?.entries = next.entries }
    }
  }

  func clear() {
    projection?.cancel()
    input = nil
    markdown = [:]
    if !entries.isEmpty { entries = [] }
  }

  deinit { projection?.cancel() }
}
