import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Message copy alignment")
struct MessageCopyAlignmentTests {
  @Test("a single-line bubble centers the entire copy target")
  func singleLine() throws {
    for padding: CGFloat in [9, 13] {
      let (bubble, action) = try bounds("Single line", padding: padding)
      #expect(abs(bubble.midY - action.midY) <= 1)
    }
  }

  @Test("explicit and soft-wrapped multiline bubbles keep the copy target at the bottom")
  func multipleLines() throws {
    for text in ["First\nSecond", String(repeating: "自动换行的消息", count: 8)] {
      let (bubble, action) = try bounds(text, padding: 13)
      #expect(abs(bubble.maxY - action.maxY) <= 1)
    }
  }

  private func bounds(_ text: String, padding: CGFloat) throws -> (CGRect, CGRect) {
    let renderer = ImageRenderer(
      content:
        HStack(alignment: .bottom, spacing: 8) {
          VStack(alignment: .leading) {
            Text(text)
              .font(Theme.TypeScale.body)
              .frame(width: 160)
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(padding)
          .background(Color(red: 1, green: 0, blue: 0))
          .messageCopyAlignment()
          Color(red: 0, green: 0, blue: 1)
            .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
        }
    )
    renderer.scale = 1
    let bitmap = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    var red: [Int] = []
    var blue: [Int] = []
    for y in 0..<bitmap.pixelsHigh {
      for x in 0..<bitmap.pixelsWide {
        guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        if color.redComponent > 0.9 && color.blueComponent < 0.1 { red.append(y) }
        if color.blueComponent > 0.9 && color.redComponent < 0.1 { blue.append(y) }
      }
    }
    func rectangle(_ rows: [Int]) throws -> CGRect {
      let low = try #require(rows.min())
      let high = try #require(rows.max())
      return CGRect(x: 0, y: low, width: 1, height: high - low + 1)
    }
    return try (rectangle(red), rectangle(blue))
  }
}
