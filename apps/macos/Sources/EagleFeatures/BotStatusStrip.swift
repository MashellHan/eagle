import BotsCore
import EagleDesign
import SwiftUI

/// The strip above a bot's conversation: connection state, the recover and stop
/// affordances, and the last error. It is one compact row so the transcript keeps its
/// height.
struct BotStatusStrip: View {
  let subtitle: String
  let error: String?
  let canRecover: Bool
  let running: Bool
  let onRecover: () -> Void
  let onAbort: () -> Void
  let onDismissError: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Circle()
        .fill(tint)
        .frame(width: 6, height: 6)
      Text(error ?? subtitle)
        .font(Theme.TypeScale.note)
        .foregroundStyle(error == nil ? Theme.Palette.textSecondary : Theme.Palette.destructive)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 0)
      if canRecover {
        Button("恢复", action: onRecover)
          .buttonStyle(.borderless)
          .font(Theme.TypeScale.note)
      }
      if running {
        Button("停止", action: onAbort)
          .buttonStyle(.borderless)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.destructive)
      }
      if error != nil {
        Button {
          onDismissError()
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 9, weight: .bold))
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Theme.Palette.textMuted)
      }
    }
    .padding(.horizontal, Theme.Metric.contentInset)
    .frame(height: 26)
    .background(Theme.Palette.surface)
  }

  private var tint: Color {
    if error != nil || canRecover { return Theme.Palette.destructive }
    if running { return Theme.Palette.accentFill }
    return Theme.Palette.textMuted
  }
}
