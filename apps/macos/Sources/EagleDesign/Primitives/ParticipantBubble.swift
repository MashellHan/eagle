import SwiftUI

/// Centred participant identity in the window header. Clicking it toggles the
/// inspector.
public struct ParticipantBubble: View {
  private let name: String
  private let tintIndex: Int
  private let action: () -> Void
  @State private var hovering = false

  public init(name: String, tintIndex: Int, action: @escaping () -> Void) {
    self.name = name
    self.tintIndex = tintIndex
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Avatar(
          initial: String(name.prefix(1)),
          tint: Theme.Palette.avatarTint(tintIndex),
          size: 22,
          shape: .blob
        )
        Text(name)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
          .lineLimit(1)
      }
      .padding(.horizontal, 14)
      .frame(height: Theme.Metric.headerControlHeight)
      .background(Capsule(style: .continuous).fill(hovering ? Theme.Palette.hover : .clear))
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityLabel("\(name)，切换检查器")
  }
}
