import AppKit
import EagleDesign
import EagleFeatures
import SwiftUI

/// Headless snapshot entry point. Renders the shell and the template gallery to
/// PNG files so the layout can be reviewed without screen-recording permission.
///
/// `ImageRenderer` cannot draw AppKit-backed views (`ScrollView`, `TextField`),
/// so this hosts each view in an offscreen `NSWindow` and caches its display.
///
///     swift run SnapshotRenderer [output-directory]
@main
struct SnapshotRenderer {
  @MainActor
  static func main() {
    let output =
      CommandLine.arguments.count > 1
      ? CommandLine.arguments[1]
      : ".local/macos-snapshots"
    let directory = URL(fileURLWithPath: output, isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)

    capture(
      WorkspaceShellView().preferredColorScheme(.light),
      size: CGSize(width: 1728, height: 1082),
      named: "shell-1728x1082",
      in: directory
    )
    capture(
      WorkspaceShellView().preferredColorScheme(.light),
      size: CGSize(width: 1300, height: 800),
      named: "shell-1300x800",
      in: directory
    )
    capture(
      TemplateGallery().preferredColorScheme(.light),
      size: CGSize(width: 1180, height: 2100),
      named: "gallery",
      in: directory
    )
    let collapsed = ShellLayoutViewModel(showsSidebar: false, showsInspector: false)
    capture(
      WorkspaceShellView(layout: collapsed).preferredColorScheme(.light),
      size: CGSize(width: 1440, height: 900),
      named: "shell-collapsed",
      in: directory
    )

    let account = AccountMenuViewModel()
    capture(
      AccountMenu(rows: account.rows, onSelect: { _ in })
        .padding(20)
        .background(Theme.Palette.canvas),
      size: CGSize(width: 266, height: 360),
      named: "account-menu",
      in: directory
    )

    let machines = SettingsViewModel()
    machines.selection = .machines
    capture(
      SettingsView(model: machines).preferredColorScheme(.light),
      size: CGSize(width: 920, height: 720),
      named: "settings-machines",
      in: directory
    )

    let general = SettingsViewModel()
    general.selection = .general
    capture(
      SettingsView(model: general).preferredColorScheme(.light),
      size: CGSize(width: 920, height: 720),
      named: "settings-general",
      in: directory
    )

    print("wrote snapshots to \(directory.path)")
  }

  @MainActor
  private static func capture<V: View>(
    _ view: V, size: CGSize, named name: String, in directory: URL
  ) {
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: .aqua)
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(origin: .zero, size: size)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    // Let SwiftUI finish its first layout pass before caching the display.
    RunLoop.main.run(until: Date().addingTimeInterval(0.35))
    host.layoutSubtreeIfNeeded()

    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
      print("failed to allocate bitmap for \(name)")
      return
    }
    host.cacheDisplay(in: host.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else {
      print("failed to encode \(name)")
      return
    }
    try? png.write(to: directory.appendingPathComponent("\(name).png"))
    window.contentView = nil
  }
}
