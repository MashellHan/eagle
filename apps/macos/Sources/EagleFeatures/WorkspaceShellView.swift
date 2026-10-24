import EagleDesign
import SwiftUI

/// Composes the three columns with their view models. This is the only place
/// where design components and feature state meet.
public struct WorkspaceShellView: View {
  @StateObject private var list: WorkspaceListViewModel
  @StateObject private var chat: ChatViewModel
  @StateObject private var inspector: InspectorViewModel
  @StateObject private var layout: ShellLayoutViewModel
  @StateObject private var account = AccountMenuViewModel()
  @StateObject private var settings = SettingsViewModel()
  @State private var showsAccountMenu = false
  @State private var showsSettings = false
  @AppStorage("eagle.appearance") private var appearance = "system"

  public init(
    list: WorkspaceListViewModel = WorkspaceListViewModel(),
    chat: ChatViewModel = ChatViewModel(),
    inspector: InspectorViewModel = InspectorViewModel(),
    layout: ShellLayoutViewModel = ShellLayoutViewModel()
  ) {
    _list = StateObject(wrappedValue: list)
    _chat = StateObject(wrappedValue: chat)
    _inspector = StateObject(wrappedValue: inspector)
    _layout = StateObject(wrappedValue: layout)
  }

  public var body: some View {
    let item = list.selectedItem
    ZStack(alignment: .bottomLeading) {
      ThreeColumnShell(
        showsSidebar: layout.showsSidebar,
        showsInspector: layout.showsInspector,
        sidebarWidth: layout.sidebarWidth,
        inspectorWidth: layout.inspectorWidth,
        onResizeSidebar: { layout.setSidebarWidth($0) },
        onResizeInspector: { layout.setInspectorWidth($0) }
      ) {
        SidebarPanel(
          sections: list.sections,
          selection: list.selection,
          width: layout.sidebarWidth,
          onSelect: { list.select($0) },
          onToggleSection: { list.toggleSection($0) },
          onRenameSection: { list.renameSection($0, to: $1) },
          onDeleteSection: { list.deleteSection($0) },
          onCreateSection: { list.createSection() },
          onRenameItem: { list.renameItem($0, to: $1) },
          onDeleteItem: { list.deleteItem($0) },
          onCollapse: { layout.toggleSidebar() },
          onAccount: { showsAccountMenu = true },
          unreadCount: 2
        )
      } conversation: {
        ConversationColumn(
          title: item?.title ?? "依赖修复专家",
          subtitle: item?.tag ?? "GitHub",
          tintIndex: item?.tintIndex ?? 2,
          entries: chat.entries,
          draft: $chat.draft,
          onSend: { chat.send() },
          showsSidebar: layout.showsSidebar,
          showsInspector: layout.showsInspector,
          onShowSidebar: { layout.toggleSidebar() },
          onToggleInspector: { layout.toggleInspector() }
        )
      } inspector: {
        InspectorColumn(
          name: item?.title ?? "依赖修复专家",
          subtitle: item?.tag ?? "GitHub",
          tintIndex: item?.tintIndex ?? 2,
          width: layout.inspectorWidth,
          artifacts: inspector.artifacts,
          jobs: inspector.jobs,
          tab: $inspector.tab,
          onToggleJob: { inspector.setJob($0, isOn: $1) },
          onCollapse: { layout.toggleInspector() }
        )
      }
      .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSidebar)) { _ in
        layout.toggleSidebar()
      }
      .onReceive(NotificationCenter.default.publisher(for: .eagleToggleInspector)) { _ in
        layout.toggleInspector()
      }

      if showsAccountMenu {
        Color.black.opacity(0.001)
          .ignoresSafeArea()
          .onTapGesture { showsAccountMenu = false }
        AccountMenu(rows: account.rows) { row in
          showsAccountMenu = false
          if row.id == "settings" { showsSettings = true }
        }
        .padding(.leading, Theme.Metric.contentInset)
        .padding(.bottom, Theme.Metric.footerHeight + Theme.Metric.footerBottom + 6)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
    }
    .animation(.snappy(duration: 0.18), value: showsAccountMenu)
    .overlay {
      if showsSettings {
        settingsOverlay
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSettings)) { _ in
      showsSettings.toggle()
    }
  }

  /// Centred settings card over a blurred, dimmed copy of the window. The
  /// traffic lights are hidden while it is open so the card owns the chrome.
  private var settingsOverlay: some View {
    ZStack {
      Rectangle()
        .fill(.ultraThinMaterial)
        .overlay(Color.black.opacity(0.12))
        .ignoresSafeArea()
        .onTapGesture { showsSettings = false }

      SettingsView(model: settings, onClose: { showsSettings = false })
        .frame(width: Theme.Metric.settingsWidth, height: Theme.Metric.settingsHeight)
        .background(
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(Theme.Palette.surface)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
        .shadow(color: .black.opacity(0.28), radius: 40, y: 18)
        .background(TrafficLights(hidden: true))
    }
    .transition(.opacity)
  }
}
