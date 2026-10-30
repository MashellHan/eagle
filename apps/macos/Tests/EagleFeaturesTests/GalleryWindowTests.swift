import AppKit
import Testing

@testable import EagleFeatures

@Suite("Gallery owner", .serialized)
@MainActor
struct GalleryWindowTests {
  @Test("reopening the front gallery preserves its real workspace and settings callback")
  func repeatShow() throws {
    let owner = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled], backing: .buffered, defer: false)
    let gallery = GalleryWindowController()
    var opens = 0
    gallery.show(from: owner, onShowSettings: { opens += 1 })
    let window = try #require(gallery.window)
    defer {
      window.orderOut(nil)
      owner.orderOut(nil)
    }
    gallery.show(from: window)
    #expect(gallery.owner === owner)
    gallery.openSettings()
    #expect(opens == 1)
    #expect(!window.isVisible)
  }

  @Test("a different workspace can explicitly take ownership of the gallery")
  func newOwner() throws {
    let first = NSWindow()
    let second = NSWindow()
    let gallery = GalleryWindowController()
    var opens = 0
    gallery.show(from: first, onShowSettings: { opens += 1 })
    gallery.show(from: second, onShowSettings: { opens += 10 })
    defer {
      gallery.window?.orderOut(nil)
      first.orderOut(nil)
      second.orderOut(nil)
    }
    gallery.openSettings()
    #expect(gallery.owner === second)
    #expect(opens == 10)
  }
}
