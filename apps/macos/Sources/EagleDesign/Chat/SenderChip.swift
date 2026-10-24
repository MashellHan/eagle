import SwiftUI

/// Attribution chip shown above the first assistant turn: a soft capsule with
/// the participant avatar and name, centred over the column.
public struct SenderChip: View {
  private let name: String
  private let tintIndex: Int

  public init(name: String, tintIndex: Int) {
    self.name = name
    self.tintIndex = tintIndex
  }

  public var body: some View {
    HStack(spacing: 9) {
      Avatar(
        initial: String(name.prefix(1)),
        tint: Theme.Palette.avatarTint(tintIndex),
        size: 24,
        shape: .blob
      )
      Text(name)
        .font(Theme.TypeScale.cardTitle)
        .foregroundStyle(Theme.Palette.textPrimary)
    }
    .padding(.leading, 8)
    .padding(.trailing, 16)
    .padding(.vertical, 8)
    .background(Capsule(style: .continuous).fill(Theme.Palette.card))
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
    .accessibilityElement(children: .combine)
  }
}
