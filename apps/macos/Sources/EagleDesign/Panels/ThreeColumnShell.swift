import SwiftUI

/// The whole window: sidebar, conversation, inspector. Side columns collapse
/// with a slide; their dividers drag to resize.
public struct ThreeColumnShell<Sidebar: View, Conversation: View, Inspector: View>: View {
  private let sidebar: Sidebar
  private let conversation: Conversation
  private let inspector: Inspector
  private let showsSidebar: Bool
  private let showsInspector: Bool
  private let sidebarWidth: CGFloat
  private let inspectorWidth: CGFloat
  private let onResizeSidebar: (CGFloat) -> Void
  private let onResizeInspector: (CGFloat) -> Void

  public init(
    showsSidebar: Bool = true,
    showsInspector: Bool = true,
    sidebarWidth: CGFloat = Theme.Metric.sidebarWidth,
    inspectorWidth: CGFloat = Theme.Metric.inspectorWidth,
    onResizeSidebar: @escaping (CGFloat) -> Void = { _ in },
    onResizeInspector: @escaping (CGFloat) -> Void = { _ in },
    @ViewBuilder sidebar: () -> Sidebar,
    @ViewBuilder conversation: () -> Conversation,
    @ViewBuilder inspector: () -> Inspector
  ) {
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
    self.sidebarWidth = sidebarWidth
    self.inspectorWidth = inspectorWidth
    self.onResizeSidebar = onResizeSidebar
    self.onResizeInspector = onResizeInspector
    self.sidebar = sidebar()
    self.conversation = conversation()
    self.inspector = inspector()
  }

  public var body: some View {
    HStack(spacing: 0) {
      if showsSidebar {
        sidebar
          .frame(width: sidebarWidth)
          .transition(.move(edge: .leading).combined(with: .opacity))
        ResizeHandle(onDrag: onResizeSidebar)
          .transition(.opacity)
      }

      conversation
        .frame(maxWidth: .infinity)

      if showsInspector {
        ResizeHandle(onDrag: onResizeInspector)
          .transition(.opacity)
        inspector
          .frame(width: inspectorWidth)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
    .animation(.snappy(duration: Theme.Metric.collapseDuration), value: showsSidebar)
    .animation(.snappy(duration: Theme.Metric.collapseDuration), value: showsInspector)
  }
}
