import SwiftUI

/// White card row with a leading glyph and a trailing chevron.
public struct ChevronRow: View {
  private let systemName: String
  private let title: String
  private let action: (() -> Void)?
  @LocalState private var hovering = false

  public init(systemName: String, title: String, action: (() -> Void)? = nil) {
    self.systemName = systemName
    self.title = title
    self.action = action
  }

  public var body: some View {
    Button {
      action?()
    } label: {
      HStack(spacing: 10) {
        Image(systemName: systemName)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Theme.Palette.textSecondary)
          .frame(width: 16)
        Text(title)
          .font(Theme.TypeScale.cardTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 14)
      .frame(height: Theme.Metric.inspectorRowHeight)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
      .opacity(hovering ? 0.82 : 1)
    }
    .buttonStyle(.plain)
    .disabled(action == nil)
    .onHover { hovering = $0 }
    .accessibilityLabel(title)
  }
}

/// Card row with a title, optional schedule text and a switch.
public struct ToggleRow: View {
  private let title: String
  private let detail: String?
  @Binding private var isOn: Bool

  public init(title: String, detail: String? = nil, isOn: Binding<Bool>) {
    self.title = title
    self.detail = detail
    self._isOn = isOn
  }

  public var body: some View {
    HStack(alignment: .center, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(Theme.TypeScale.cardTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        if let detail {
          Text(detail)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
      Spacer(minLength: 8)
      SwitchToggle(isOn: $isOn, label: title)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }
}
