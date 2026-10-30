import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Gallery settings entry", .serialized)
@MainActor
struct GallerySettingsTests {
  @Test("the in-app menu exposes a settings button beside the gallery navigation")
  func settingsEntry() throws {
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    var opened = 0
    let host = NSHostingView(rootView: TemplateGallery(onShowSettings: { opened += 1 }))
    host.frame = NSRect(x: 0, y: 0, width: 1180, height: 900)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }

    let entries = accessibilityEntries(host)
    #expect(entries.contains { title($0) == "会话状态" })
    let settings = try #require(
      entries.first {
        title($0) == "设置…" && attribute($0, "AXRole") as? String == "AXButton"
      })
    let press = NSSelectorFromString("accessibilityPerformPress")
    #expect(settings.responds(to: press))
    typealias Press = @convention(c) (AnyObject, Selector) -> Bool
    let invoke = unsafeBitCast(settings.method(for: press), to: Press.self)
    #expect(invoke(settings, press))
    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    #expect(opened == 1)
  }

  private func title(_ node: NSObject) -> String? {
    (attribute(node, "AXTitle") ?? attribute(node, "AXDescription")) as? String
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let modern = NSSelectorFromString(
      [
        "AXTitle": "accessibilityTitle", "AXDescription": "accessibilityLabel",
        "AXChildren": "accessibilityChildren",
        "AXRole": "accessibilityRole",
      ][name] ?? name)
    if node.responds(to: modern) { return node.perform(modern)?.takeUnretainedValue() }
    let selector = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: selector) else { return nil }
    return node.perform(selector, with: name)?.takeUnretainedValue()
  }

  private func accessibilityEntries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element]
      + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(accessibilityEntries)
  }
}
