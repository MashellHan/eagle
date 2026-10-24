import SwiftUI

/// Small neutral pill, e.g. the `Personal` label beside a conversation title.
public struct Tag: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text)
      .font(Theme.TypeScale.pill)
      .foregroundStyle(Theme.Palette.textSecondary)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(
        RoundedRectangle(cornerRadius: 5, style: .continuous)
          .fill(Theme.Palette.line)
      )
      .fixedSize()
  }
}

/// One-pixel separator that never accumulates inset.
public struct PanelDivider: View {
  private let vertical: Bool

  public init(vertical: Bool = false) {
    self.vertical = vertical
  }

  public var body: some View {
    Rectangle()
      .fill(Theme.Palette.line)
      .frame(
        width: vertical ? Theme.Metric.hairline : nil,
        height: vertical ? nil : Theme.Metric.hairline
      )
  }
}

/// 11 pt secondary label used for grouping and hints.
public struct SectionLabel: View {
  private let text: String
  private let count: Int?

  public init(_ text: String, count: Int? = nil) {
    self.text = text
    self.count = count
  }

  public var body: some View {
    HStack(spacing: 6) {
      Text(text)
        .font(Theme.TypeScale.sectionLabel)
        .foregroundStyle(Theme.Palette.textSecondary)
        .tracking(0.2)
      Spacer(minLength: 0)
      if let count {
        Text("\(count)")
          .font(Theme.TypeScale.sectionLabel)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .frame(height: Theme.Metric.sectionHeaderHeight, alignment: .bottom)
    .accessibilityElement(children: .combine)
  }
}
