import BotsCore
import Foundation
import Testing

@testable import EagleFeatures

@MainActor
@Suite("Transcript projection")
struct BotsTranscriptTests {
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
