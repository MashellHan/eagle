import EagleDesign
import SwiftUI

/// Composes the three columns with their view models. This is the only place
/// where design components and feature state meet.
public struct WorkspaceShellView: View {
  @StateObject private var list: WorkspaceListViewModel
  @StateObject private var chat: ChatViewModel
  @StateObject private var inspector: InspectorViewModel
  @StateObject private var layout: ShellLayoutViewModel

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
        onShowSidebar: { layout.toggleSidebar() }
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
  }
}
