import AppKit
import Testing

@testable import EagleDesign

@MainActor
@Suite("Message copy")
struct MessageCopyTests {
  @Test("copy writes the original message and reports success")
  func copiesSource() {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let model = MessageCopyViewModel(pasteboard: board)
    let source = "**可以正常轮询。**截至本机时间\n第二行"
    model.copy(source)
    #expect(board.string(forType: .string) == source)
    #expect(model.feedback == .copied)
    model.resetFeedback()
    #expect(model.feedback == .idle)
  }

  @Test("an empty streaming bubble cannot clear the clipboard")
  func emptyMessage() {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    board.setString("Keep", forType: .string)
    let model = MessageCopyViewModel(pasteboard: board)
    model.copy("")
    #expect(board.string(forType: .string) == "Keep")
    #expect(model.feedback == .idle)
  }
}
