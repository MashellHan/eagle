import SwiftUI

/// Circled icon that opens a menu instead of acting on click, drawn like
/// `IconButton(style: .circled)` so the header keeps one shape.
public struct MenuIconButton<Content: View>: View {
  private let systemName: String
  private let label: String
  private let size: CGFloat
  private let content: Content

  @State private var hovering = false

  public init(
    systemName: String,
    label: String,
    size: CGFloat = Theme.Metric.iconButton,
    @ViewBuilder content: () -> Content
  ) {
    self.systemName = systemName
    self.label = label
    self.size = size
    self.content = content()
  }

  public var body: some View {
    Menu {
      content
    } label: {
      Image(systemName: systemName)
        .font(.system(size: size * 0.55, weight: .medium))
        .foregroundStyle(Theme.Palette.textPrimary)
        .frame(width: size, height: size)
        .background {
          Circle()
            .fill(hovering ? Theme.Palette.hover : Theme.Palette.card)
            .overlay(
              Circle().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
            )
        }
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .contentShape(Circle())
    .onHover { hovering = $0 }
    .accessibilityLabel(label)
    .help(label)
  }
}
