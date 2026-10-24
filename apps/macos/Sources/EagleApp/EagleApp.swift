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
        .frame(minWidth: 1280, minHeight: 760)
        .background(WindowConfigurator())
        .preferredColorScheme(.light)
    }
    .defaultSize(width: Theme.Metric.windowWidth, height: Theme.Metric.windowHeight)
    // Immersive: no title bar, traffic lights float over the sidebar.
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)
    .commands {
      CommandGroup(after: .newItem) {
        Button("模板库") {
          GalleryWindow.show()
        }
        .keyboardShortcut("g", modifiers: [.command, .shift])

        Divider()

        Button("收起/展开侧栏") {
          NotificationCenter.default.post(name: .eagleToggleSidebar, object: nil)
        }
        .keyboardShortcut("1", modifiers: [.command, .control])

        Button("收起/展开检查器") {
          NotificationCenter.default.post(name: .eagleToggleInspector, object: nil)
        }
        .keyboardShortcut("2", modifiers: [.command, .control])
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

/// Lets the whole window be dragged by its background, which is what makes the
/// hidden title bar feel natural.
struct WindowConfigurator: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async {
      view.window?.isMovableByWindowBackground = true
      view.window?.styleMask.insert(.fullSizeContentView)
      view.window?.titlebarAppearsTransparent = true
      view.window?.titleVisibility = .hidden
      view.window?.toolbar = nil
    }
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {}
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
      styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Eagle 模板库"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.contentView = NSHostingView(
      rootView: TemplateGallery().preferredColorScheme(.light)
    )
    window.center()
    window.makeKeyAndOrderFront(nil)
    Self.window = window
  }
}
