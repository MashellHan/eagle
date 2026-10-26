import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Unread badge appearance")
struct UnreadBadgeTests {
  @Test("positive counts have an accent capsule and white digits; zero has no badge")
  func badgePixels() throws {
    for scheme in [ColorScheme.light, .dark] {
      for count in [0, 2, 128] {
        let renderer = ImageRenderer(
          content: SectionLabel("Group", unreadCount: count)
            .frame(width: 240, height: 24)
            .preferredColorScheme(scheme))
        renderer.scale = 2
        let image = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
        var accent = 0
        var white = 0
        for x in (image.pixelsWide - 100)..<image.pixelsWide {
          for y in 0..<image.pixelsHigh {
            guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.sRGB),
              color.alphaComponent > 0.9
            else { continue }
            if color.blueComponent > 0.5 && color.blueComponent > color.redComponent * 1.5 {
              accent += 1
            }
            if min(color.redComponent, color.greenComponent, color.blueComponent) > 0.9 {
              white += 1
            }
          }
        }
        #expect(count == 0 ? accent == 0 && white == 0 : accent > 100 && white > 5)
      }
    }
  }
}
