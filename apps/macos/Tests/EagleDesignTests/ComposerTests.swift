import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Composer layout")
struct ComposerTests {
  @Test("the composer grows through three lines and caps subsequent lines")
  func lineHeights() {
    let single = height("One")
    let two = height("One\nTwo")
    let three = height("One\nTwo\nThree")
    let four = height("One\nTwo\nThree\nFour")
    #expect(single == Theme.Metric.composerHeight)
    #expect(two > single)
    #expect(three > two)
    #expect(abs(four - three) < 1)
    #expect(height("") == single)
  }

  @Test("soft-wrapped text grows without explicit newlines and stays capped")
  func wrapping() {
    let single = height("Hello")
    let wrapped = height(String(repeating: "Hello world ", count: 6))
    let overflow = height(String(repeating: "Hello world ", count: 60))
    #expect(wrapped > single)
    #expect(abs(overflow - height("One\nTwo\nThree")) < 1)
  }

  private func height(_ text: String) -> CGFloat {
    let host = NSHostingView(
      rootView: Composer(placeholder: "Message", text: .constant(text), onSend: {})
        .frame(width: 360)
    )
    return host.fittingSize.height
  }
}
