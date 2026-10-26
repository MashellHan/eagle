import BotsCore
import Combine
import EagleDesign
import Foundation

actor BotsTranscriptProjector {
  private let renderer = MarkdownRenderer()
  private var prepared: [String: (text: String, blocks: [RenderedMarkdownBlock])] = [:]

  func project(_ state: ConversationState) async throws -> BotsTranscriptProjection {
    try Task.checkCancellation()
    let entries = BotsPresenter().transcript(for: state)
    var next: [String: (text: String, blocks: [RenderedMarkdownBlock])] = [:]
    for entry in entries {
      switch entry {
      case .assistant(_, let blocks), .streamingAssistant(_, let blocks):
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
  private var input: ConversationState?
  private var projection: Task<Void, Never>?

  func update(_ state: ConversationState) {
    guard input != state else { return }
    if input?.botId != state.botId { clear() }
    input = state
    projection?.cancel()
    projection = Task { [weak self, projector] in
      guard let next = try? await projector.project(state), !Task.isCancelled else { return }
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
