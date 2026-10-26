import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Icon button styles")
struct IconButtonTests {
  @Test("circled buttons render a visible surround rather than the plain style")
  func circularBackground() throws {
    let plain = try render(.plain)
    let circled = try render(.circled)
    let plainEdge = try #require(plain.colorAt(x: 20, y: 5))
    let circledEdge = try #require(circled.colorAt(x: 20, y: 5))
    #expect(plainEdge.alphaComponent < 0.1)
    #expect(circledEdge.alphaComponent > 0.9)
    #expect(try #require(circled.colorAt(x: 4, y: 4)).alphaComponent < 0.1)
  }

  private func render(_ style: IconButton.Style) throws -> NSBitmapImageRep {
    let renderer = ImageRenderer(
      content: IconButton(systemName: "bell", label: "Notifications", style: style, action: {})
        .padding(4)
    )
    renderer.scale = 1
    return NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
  }
}
