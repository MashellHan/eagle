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

    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      capture(
        ConversationColumn(
          title: "一个需要保持停止按钮可见的很长的研究员名字", subtitle: "Bots", tintIndex: 2,
          entries: [.streamingAssistant(id: "preview", blocks: [.paragraph("正在整理已经观察到的信息。")])],
          draft: .constant("第一行：输入框向上展开。\n第二行：按钮留在底部。\n第三行：高度到此为止。\n第四行：在内部滚动。"),
          onSend: {},
          participantStatus: ParticipantStatus(label: "回答中", phase: .working, canStop: true)
        )
        .preferredColorScheme(scheme),
        size: CGSize(width: 480, height: 520), named: "chat-experience-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
    }

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
      size: CGSize(width: 1180, height: 820),
      named: "gallery",
      in: directory
    )
    capture(
      TemplateGallery(darkPreview: true),
      size: CGSize(width: 1180, height: 820), named: "gallery-dark", in: directory,
      appearance: .darkAqua
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

    capture(
      WorkspaceShellView().preferredColorScheme(.dark),
      size: CGSize(width: 1728, height: 1082),
      named: "shell-dark",
      in: directory
    )
    capture(
      SettingsView(model: SettingsViewModel()).preferredColorScheme(.dark),
      size: CGSize(width: 920, height: 720),
      named: "settings-dark",
      in: directory
    )

    let inspectorTasks = [
      InspectorTaskRow(
        id: "t_12", title: "生成回答", symbolName: "sparkles", status: "运行中", depth: 0,
        isRunning: true, isBlocked: false),
      InspectorTaskRow(
        id: "t_13", title: "工具调用", symbolName: "wrench.and.screwdriver", status: "等待",
        depth: 1, isRunning: false, isBlocked: false),
      InspectorTaskRow(
        id: "t_14", title: "子 Agent", symbolName: "person.2", status: "已停放：重试次数过多",
        depth: 2, isRunning: false, isBlocked: true),
      InspectorTaskRow(
        id: "t_15", title: "上下文压缩", symbolName: "rectangle.compress.vertical",
        status: "休眠", depth: 0, isRunning: false, isBlocked: false),
    ]
    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      capture(
        InspectorColumn(
          name: "研究员",
          subtitle: "Bots",
          tintIndex: 2,
          artifacts: [
            InspectorArtifact(id: "a1", title: "deps 2026-10-24 sleepy"),
            InspectorArtifact(id: "a2", title: "deps 2026-10-24 next-ai"),
          ],
          jobs: [
            InspectorJob(id: "j1", title: "每日依赖修复调度", detail: "每天 8:47", isOn: true),
            InspectorJob(id: "j2", title: "依赖修复进度 10-24", detail: "每小时", isOn: false),
          ],
          tasks: inspectorTasks,
          tab: .constant(.detail)
        )
        .preferredColorScheme(scheme),
        size: CGSize(width: Theme.Metric.inspectorWidth, height: 780),
        named: "inspector-\(name)",
        in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
    }
    capture(
      InspectorColumn(
        name: "新的 Bot",
        subtitle: "Bots",
        tintIndex: 5,
        artifacts: [],
        jobs: [],
        tasks: [],
        tab: .constant(.detail)
      )
      .preferredColorScheme(.light),
      size: CGSize(width: Theme.Metric.inspectorWidth, height: 780),
      named: "inspector-empty",
      in: directory
    )

    print("wrote snapshots to \(directory.path)")
  }

  @MainActor
  private static func capture<V: View>(
    _ view: V, size: CGSize, named name: String, in directory: URL,
    appearance: NSAppearance.Name = .aqua
  ) {
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: appearance)
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
