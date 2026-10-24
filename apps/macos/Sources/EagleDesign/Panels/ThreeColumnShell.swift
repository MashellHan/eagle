import SwiftUI

/// The whole window: sidebar, conversation, inspector with hairline dividers.
/// Widths follow the reference (411 / flexible / 319).
public struct ThreeColumnShell<Sidebar: View, Conversation: View, Inspector: View>: View {
  private let sidebar: Sidebar
  private let conversation: Conversation
  private let inspector: Inspector
  private let showsInspector: Bool

  public init(
    showsInspector: Bool = true,
    @ViewBuilder sidebar: () -> Sidebar,
    @ViewBuilder conversation: () -> Conversation,
    @ViewBuilder inspector: () -> Inspector
  ) {
    self.showsInspector = showsInspector
    self.sidebar = sidebar()
    self.conversation = conversation()
    self.inspector = inspector()
  }

  public var body: some View {
    HStack(spacing: 0) {
      sidebar
      PanelDivider(vertical: true)
      conversation
        .frame(maxWidth: .infinity)
      if showsInspector {
        PanelDivider(vertical: true)
        inspector
      }
    }
    .background(Theme.Palette.surface)
  }
}
