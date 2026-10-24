import EagleDesign
import SwiftUI

/// Composes the three columns with their view models. This is the only place
/// where design components and feature state meet.
public struct WorkspaceShellView: View {
  @StateObject private var list: WorkspaceListViewModel
  @StateObject private var chat: ChatViewModel
  @StateObject private var inspector: InspectorViewModel
  @LocalState private var showsInspector: Bool

  public init(
    list: WorkspaceListViewModel = WorkspaceListViewModel(),
    chat: ChatViewModel = ChatViewModel(),
    inspector: InspectorViewModel = InspectorViewModel(),
    showsInspector: Bool = true
  ) {
    _list = StateObject(wrappedValue: list)
    _chat = StateObject(wrappedValue: chat)
    _inspector = StateObject(wrappedValue: inspector)
    _showsInspector = LocalState(wrappedValue: showsInspector)
  }

  public var body: some View {
    let item = list.selectedItem
    ThreeColumnShell(showsInspector: showsInspector) {
      SidebarPanel(
        profileInitial: "监",
        profileName: "监察御史",
        profilePlan: "Personal",
        groups: list.groups,
        selection: list.selection,
        onSelect: { list.select($0) },
        unreadCount: 2
      )
    } conversation: {
      ConversationColumn(
        title: item?.title ?? "依赖修复专家",
        subtitle: item?.tag ?? "GitHub",
        tintIndex: item?.tintIndex ?? 2,
        entries: chat.entries,
        draft: $chat.draft,
        onSend: { chat.send() }
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
        onClose: { showsInspector = false }
      )
    }
  }
}
