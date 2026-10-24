import AppKit
import SwiftUI

/// Hides or restores the window's traffic lights. Used while a modal card owns
/// the window chrome.
public struct TrafficLights: NSViewRepresentable {
  private let hidden: Bool

  public init(hidden: Bool) {
    self.hidden = hidden
  }

  public func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async { apply(to: view.window) }
    return view
  }

  public func updateNSView(_ view: NSView, context: Context) {
    DispatchQueue.main.async { apply(to: view.window) }
  }

  private func apply(to window: NSWindow?) {
    guard let window else { return }
    for button: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
      window.standardWindowButton(button)?.isHidden = hidden
    }
  }
}
