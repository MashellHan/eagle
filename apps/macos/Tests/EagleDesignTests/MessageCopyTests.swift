import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Message copy")
struct MessageCopyTests {
  @Test("the copy glyph is small while its hit target stays full size")
  func smallGlyph() throws {
    let renderer = ImageRenderer(
      content: MessageCopyButton(text: "Message", label: "Copy")
    )
    renderer.scale = 1
    let bitmap = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    #expect(bitmap.pixelsWide == Int(Theme.Metric.hitTarget))
    #expect(bitmap.pixelsHigh == Int(Theme.Metric.hitTarget))
    var paintedRows = Set<Int>()
    for y in 0..<bitmap.pixelsHigh {
      for x in 0..<bitmap.pixelsWide where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 {
        paintedRows.insert(y)
      }
    }
    #expect(!paintedRows.isEmpty)
    #expect(paintedRows.count <= 13)
  }

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
