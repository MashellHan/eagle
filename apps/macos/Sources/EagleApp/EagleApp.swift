import AppKit
import EagleDesign
import EagleFeatures
import SwiftUI

@main
struct EagleApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    WindowGroup("Eagle") {
      WorkspaceShellView()
        .frame(minWidth: 1200, minHeight: 720)
        .preferredColorScheme(.light)
    }
    .defaultSize(width: 1440, height: 920)
    .windowToolbarStyle(.unifiedCompact)
    .commands {
      CommandGroup(after: .newItem) {
        Button("模板库") {
          GalleryWindow.show()
        }
        .keyboardShortcut("g", modifiers: [.command, .shift])
      }
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

/// Small AppKit window so the gallery can be opened next to the shell without
/// turning it into a second primary scene.
@MainActor
enum GalleryWindow {
  private static var window: NSWindow?

  static func show() {
    if let window {
      window.makeKeyAndOrderFront(nil)
      return
    }
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 900),
      styleMask: [.titled, .closable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Eagle 模板库"
    window.contentView = NSHostingView(
      rootView: TemplateGallery().preferredColorScheme(.light)
    )
    window.center()
    window.makeKeyAndOrderFront(nil)
    Self.window = window
  }
}
