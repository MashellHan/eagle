import SwiftUI

/// The whole window: sidebar, conversation, inspector with hairline dividers.
/// Both side columns collapse with a slide and spring.
public struct ThreeColumnShell<Sidebar: View, Conversation: View, Inspector: View>: View {
  private let sidebar: Sidebar
  private let conversation: Conversation
  private let inspector: Inspector
  private let showsSidebar: Bool
  private let showsInspector: Bool

  public init(
    showsSidebar: Bool = true,
    showsInspector: Bool = true,
    @ViewBuilder sidebar: () -> Sidebar,
    @ViewBuilder conversation: () -> Conversation,
    @ViewBuilder inspector: () -> Inspector
  ) {
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
    self.sidebar = sidebar()
    self.conversation = conversation()
    self.inspector = inspector()
  }

  public var body: some View {
    HStack(spacing: 0) {
      if showsSidebar {
        sidebar
          .frame(width: Theme.Metric.sidebarWidth)
          .transition(.move(edge: .leading).combined(with: .opacity))
        PanelDivider(vertical: true).transition(.opacity)
      }

      conversation
        .frame(maxWidth: .infinity)

      if showsInspector {
        PanelDivider(vertical: true).transition(.opacity)
        inspector
          .frame(width: Theme.Metric.inspectorWidth)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
    .animation(.snappy(duration: Theme.Metric.collapseDuration), value: showsSidebar)
    .animation(.snappy(duration: Theme.Metric.collapseDuration), value: showsInspector)
  }
}
