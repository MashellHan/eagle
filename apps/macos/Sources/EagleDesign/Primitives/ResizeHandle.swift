import AppKit
import SwiftUI

/// One-pixel divider that can be dragged horizontally. Reports incremental
/// translation so the owning view model keeps the width.
public struct ResizeHandle: View {
  private let onDrag: (CGFloat) -> Void
  @LocalState private var active = false
  @LocalState private var lastTranslation: CGFloat = 0

  public init(onDrag: @escaping (CGFloat) -> Void) {
    self.onDrag = onDrag
  }

  public var body: some View {
    ZStack {
      Rectangle()
        .fill(active ? Theme.Palette.accent.opacity(0.55) : Theme.Palette.line)
        .frame(width: active ? 2 : Theme.Metric.hairline)
      Rectangle()
        .fill(Color.clear)
        .frame(width: 10)
        .contentShape(Rectangle())
    }
    .frame(width: 10)
    .onHover { hovering in
      active = hovering
      if hovering {
        NSCursor.resizeLeftRight.push()
      } else {
        NSCursor.pop()
      }
    }
    .gesture(
      DragGesture(minimumDistance: 1)
        .onChanged { value in
          let delta = value.translation.width - lastTranslation
          lastTranslation = value.translation.width
          onDrag(delta)
        }
        .onEnded { _ in lastTranslation = 0 }
    )
    .accessibilityLabel("调整栏宽")
    .accessibilityAdjustableAction { _ in }
  }
}
