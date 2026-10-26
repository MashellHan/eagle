import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Prepared transcript layout")
struct MarkdownLayoutTests {
  @Test("a long answer has its full height on the first layout")
  func firstLayout() async throws {
    let text = String(repeating: "A paragraph with **bold** text.\n\n", count: 20)
    let prepared = try await MarkdownRenderer().render(text)
    let host = NSHostingView(
      rootView: AssistantBubble(text: text, preparedBlocks: prepared).frame(width: 500))
    #expect(host.fittingSize.height > 400)
  }
}
