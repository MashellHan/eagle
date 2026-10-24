import SwiftUI

/// Attribution chip shown above the first assistant turn: white capsule with
/// the participant avatar and name, floating on the right of the column.
public struct SenderChip: View {
  private let name: String
  private let tintIndex: Int

  public init(name: String, tintIndex: Int) {
    self.name = name
    self.tintIndex = tintIndex
  }

  public var body: some View {
    HStack(spacing: 8) {
      Avatar(
        initial: String(name.prefix(1)),
        tint: Theme.Palette.avatarTint(tintIndex),
        size: 22,
        shape: .blob
      )
      Text(name)
        .font(Theme.TypeScale.cardTitle)
        .foregroundStyle(Theme.Palette.textPrimary)
    }
    .padding(.leading, 6)
    .padding(.trailing, 14)
    .padding(.vertical, 6)
    .background(Capsule().fill(Theme.Palette.card))
    .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
    .accessibilityElement(children: .combine)
  }
}
