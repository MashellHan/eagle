import Combine
import Foundation
import Testing

@testable import EagleDesign

@MainActor
@Suite("Prepared markdown")
struct MarkdownViewModelTests {
  @Test("prepared content retains inline semantics and every block family")
  func preparedBlocks() async throws {
    let blocks = try await MarkdownRenderer().render(
      "# Title\n\n**Bold** and [link](https://example.com)\n\n- item\n\n> quote\n\n```swift\nlet x = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |"
    )
    #expect(blocks.count == 6)
    guard case .paragraph(let text) = blocks[1] else {
      Issue.record("missing prepared paragraph")
      return
    }
    #expect(String(text.characters) == "Bold and link")
    #expect(text.runs.contains { $0.link == URL(string: "https://example.com") })
    #expect(
      text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    #expect(blocks[4] == .code(language: "swift", body: "let x = 1"))
  }

  @Test("unchanged text is reused and a cancelled render cannot replace its successor")
  func reuseAndCancellation() async {
    let model = MarkdownViewModel()
    await model.render("Current")
    let current = model.blocks
    var publications = 0
    let observer = model.$blocks.dropFirst().sink { _ in publications += 1 }
    defer { observer.cancel() }
    await model.render("Current")
    #expect(publications == 0)
    let obsolete = Task { await model.render(String(repeating: "**Old**\n\n", count: 1_000)) }
    obsolete.cancel()
    await obsolete.value
    #expect(model.blocks == current)
    await model.render("Latest")
    #expect(model.blocks == [.paragraph(AttributedString("Latest"))])
    #expect(publications == 1)
  }
}
