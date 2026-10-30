import AppKit
import EagleDesign
import EagleFeatures
import SwiftUI

@main
struct EagleApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @AppStorage("eagle.appearance") private var appearance = "system"

  var body: some Scene {
    WindowGroup("Eagle") {
      WorkspaceShellView(onShowGallery: { openSettings in
        GalleryWindowController.shared.show(onShowSettings: openSettings)
      })
      .frame(minWidth: 1280, minHeight: 760)
      .ignoresSafeArea()
      .background(WindowConfigurator())
      .preferredColorScheme(scheme)
    }
    .defaultSize(width: Theme.Metric.windowWidth, height: Theme.Metric.windowHeight)
    // Immersive: no title bar, traffic lights float over the sidebar.
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)
    .commands {
      CommandGroup(replacing: .appSettings) {
        Button("设置…") { NotificationCenter.default.post(name: .eagleToggleSettings, object: nil) }
          .keyboardShortcut(",", modifiers: .command)
      }
      CommandGroup(after: .newItem) {
        Button("模板库") {
          GalleryWindowController.shared.show()
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
    Task { @MainActor in await DeviceSettingsViewModel.shared.startIfNeeded() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  /// The daemon is a child of the app: quitting the app must not leave it running.
  func applicationWillTerminate(_ notification: Notification) {
    BotsDaemonSupervisor.terminateRecordedDaemon()
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

extension EagleApp {
  /// `nil` follows the system; the settings switch stores light or dark.
  fileprivate var scheme: ColorScheme? {
    switch appearance {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }
}
