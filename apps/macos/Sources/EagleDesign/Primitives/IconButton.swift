import SwiftUI

/// Borderless icon control with a hover fill and an accessibility label.
public struct IconButton: View {
  public enum Style {
    /// Plain glyph with a hover wash, used in the sidebar toolbar.
    case plain
    /// Circular button with a hairline border, used in the inspector header.
    case circled
  }

  private let systemName: String
  private let label: String
  private let size: CGFloat
  private let tint: Color
  private let style: Style
  private let action: () -> Void
  @State private var hovering = false

  public init(
    systemName: String,
    label: String,
    size: CGFloat = Theme.Metric.iconButton,
    tint: Color = Theme.Palette.textPrimary,
    style: Style = .plain,
    action: @escaping () -> Void
  ) {
    self.systemName = systemName
    self.label = label
    self.size = size
    self.tint = tint
    self.style = style
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: size * 0.55, weight: .medium))
        .foregroundStyle(tint)
        .frame(width: size, height: size)
        .background { background }
    }
    .buttonStyle(.plain)
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .accessibilityLabel(label)
    .help(label)
  }

  @ViewBuilder
  private var background: some View {
    switch style {
    case .plain:
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(hovering ? Theme.Palette.hover : .clear)
    case .circled:
      Circle()
        .fill(hovering ? Theme.Palette.hover : Theme.Palette.card)
        .overlay(Circle().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    }
  }
}

/// Small link-styled text button, e.g. `更多未读消息` / `展开`.
public struct TextAction: View {
  private let title: String
  private let action: () -> Void

  public init(_ title: String, action: @escaping () -> Void) {
    self.title = title
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.accent)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }
}
