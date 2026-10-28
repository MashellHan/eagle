import EagleDesign
import SwiftUI

/// Shown when no conversation is selected: real bots only, no sample transcript to fall back
/// on once the sample data is switched off.
struct NoConversationPlaceholder: View {
  let onCreate: () -> Void
  let onShowSidebar: () -> Void
  let showsSidebar: Bool

  var body: some View {
    VStack(spacing: 10) {
      Text("没有打开的对话")
        .font(Theme.TypeScale.bodyEmphasis)
        .foregroundStyle(Theme.Palette.textPrimary)
      Text("从侧栏选一个 Bot，或者新建一个")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
      SettingsActionButton("新建 Bot", prominent: true, action: onCreate)
        .padding(.top, 4)
      if !showsSidebar {
        IconButton(
          systemName: "sidebar.left", label: "展开侧栏", style: .circled, action: onShowSidebar
        )
        .padding(.top, 6)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }
}
