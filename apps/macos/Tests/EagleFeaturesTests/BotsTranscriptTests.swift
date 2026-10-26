import BotsCore
import Foundation
import Testing

@testable import EagleFeatures

@MainActor
@Suite("Transcript projection")
struct BotsTranscriptTests {
  @Test("published answers already contain prepared layout data")
  func preparedBeforePublication() async throws {
    let model = BotsTranscriptViewModel()
    let message = Message(
      id: "answer", role: .assistant, state: .complete, createdAt: "x",
      blocks: [.text("**Ready**\n\nBefore scrolling")])
    model.update(ConversationState(botId: "bot", messages: [message]))
    for _ in 0..<100 {
      if !model.entries.isEmpty { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let entry = try #require(model.entries.first)
    #expect(model.markdown[entry.id]?.count == 2)
    model.clear()
    #expect(model.markdown.isEmpty)
  }

  @Test("switching bots discards pending presentation work")
  func latestSelectionWins() async throws {
    let model = BotsTranscriptViewModel()
    let old = ConversationState(
      botId: "old",
      messages: (0..<200).map { index in
        Message(
          id: "old_\(index)", role: .assistant, state: .complete, createdAt: "x",
          blocks: [.text(String(repeating: "History ", count: 200))])
      })
    model.update(old)
    model.update(
      ConversationState(
        botId: "new",
        messages: [
          Message(
            id: "new_1", role: .user, state: .complete, createdAt: "x", blocks: [.text("Latest")])
        ]))
    for _ in 0..<100 {
      if model.entries.map(\.id) == ["new_1"] { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(model.entries.map(\.id) == ["new_1"])
    model.update(old)
    model.clear()
    try await Task.sleep(for: .milliseconds(30))
    #expect(model.entries.isEmpty)
  }
}
