import EagleDesign
import SwiftUI

/// Composes the three columns with their view models. This is the only place
/// where design components and feature state meet.
public struct WorkspaceShellView: View {
  @StateObject private var list: WorkspaceListViewModel
  @StateObject private var chat: ChatViewModel
  @StateObject private var inspector: InspectorViewModel
  @LocalState private var showsSidebar: Bool
  @LocalState private var showsInspector: Bool

  public init(
    list: WorkspaceListViewModel = WorkspaceListViewModel(),
    chat: ChatViewModel = ChatViewModel(),
    inspector: InspectorViewModel = InspectorViewModel(),
    showsSidebar: Bool = true,
    showsInspector: Bool = true
  ) {
    _list = StateObject(wrappedValue: list)
    _chat = StateObject(wrappedValue: chat)
    _inspector = StateObject(wrappedValue: inspector)
    _showsSidebar = LocalState(wrappedValue: showsSidebar)
    _showsInspector = LocalState(wrappedValue: showsInspector)
  }

  public var body: some View {
    let item = list.selectedItem
    ThreeColumnShell(
      showsSidebar: showsSidebar,
      showsInspector: showsInspector
    ) {
      SidebarPanel(
        profileInitial: "监",
        profileName: "监察御史",
        profilePlan: "Personal",
        groups: list.groups,
        selection: list.selection,
        onSelect: { list.select($0) },
        onCollapse: { showsSidebar = false },
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
        showsSidebar: showsSidebar,
        showsInspector: showsInspector,
        onToggleSidebar: { showsSidebar.toggle() },
        onToggleInspector: { showsInspector.toggle() }
      )
    } inspector: {
      InspectorColumn(
        name: item?.title ?? "依赖修复专家",
        subtitle: item?.tag ?? "GitHub",
        tintIndex: item?.tintIndex ?? 2,
        artifacts: inspector.artifacts,
        jobs: inspector.jobs,
        tab: $inspector.tab,
        onToggleJob: { inspector.setJob($0, isOn: $1) },
        onCollapse: { showsInspector = false }
      )
    }
    .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSidebar)) { _ in
      showsSidebar.toggle()
    }
    .onReceive(NotificationCenter.default.publisher(for: .eagleToggleInspector)) { _ in
      showsInspector.toggle()
    }
  }
}
