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
  @State private var showsAccountMenu = false
  private let onOpenSettings: () -> Void

  public init(
    list: WorkspaceListViewModel = WorkspaceListViewModel(),
    chat: ChatViewModel = ChatViewModel(),
    inspector: InspectorViewModel = InspectorViewModel(),
    layout: ShellLayoutViewModel = ShellLayoutViewModel(),
    onOpenSettings: @escaping () -> Void = {}
  ) {
    _list = StateObject(wrappedValue: list)
    _chat = StateObject(wrappedValue: chat)
    _inspector = StateObject(wrappedValue: inspector)
    _layout = StateObject(wrappedValue: layout)
    self.onOpenSettings = onOpenSettings
  }

  public var body: some View {
    let item = list.selectedItem
    let visibleColumns = (layout.showsSidebar ? 1 : 0) + (layout.showsInspector ? 1 : 0)
    let contentWidth: CGFloat =
      visibleColumns >= 2
      ? Theme.Metric.conversationMaxContentWidth
      : (visibleColumns == 1 ? 900 : 1_040)

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
          profileInitial: "监",
          profileName: "监察御史",
          profilePlan: "Personal",
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
          sender: TranscriptSender(name: item?.title ?? "依赖修复专家", tintIndex: item?.tintIndex ?? 2),
          entries: chat.entries,
          draft: $chat.draft,
          onSend: { chat.send() },
          showsSidebar: layout.showsSidebar,
          showsInspector: layout.showsInspector,
          maxContentWidth: contentWidth,
          onShowSidebar: { layout.toggleSidebar() },
          onShowInspector: { layout.toggleInspector() }
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
          if row.id == "settings" { onOpenSettings() }
        }
        .padding(.leading, Theme.Metric.contentInset)
        .padding(.bottom, Theme.Metric.footerHeight + Theme.Metric.footerBottom + 6)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
    }
    .animation(.snappy(duration: 0.18), value: showsAccountMenu)
  }
}
