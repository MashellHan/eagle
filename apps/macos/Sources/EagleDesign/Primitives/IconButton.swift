import SwiftUI

/// Borderless icon control with a hover fill and an accessibility label.
public struct IconButton: View {
  private let systemName: String
  private let label: String
  private let size: CGFloat
  private let tint: Color
  private let action: () -> Void
  @LocalState private var hovering = false

  public init(
    systemName: String,
    label: String,
    size: CGFloat = Theme.Metric.iconButton,
    tint: Color = Theme.Palette.textPrimary,
    action: @escaping () -> Void
  ) {
    self.systemName = systemName
    self.label = label
    self.size = size
    self.tint = tint
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: size * 0.46, weight: .medium))
        .foregroundStyle(tint)
        .frame(width: size, height: size)
        .background(
          RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
            .fill(hovering ? Theme.Palette.hover : .clear)
        )
    }
    .buttonStyle(.plain)
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .accessibilityLabel(label)
    .help(label)
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
