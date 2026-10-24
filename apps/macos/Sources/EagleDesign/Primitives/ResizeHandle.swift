import AppKit
import SwiftUI

/// One-pixel divider that drags a column width. It reports the *absolute* width
/// from the drag origin measured in the global coordinate space, so the layout
/// cannot feed back into the gesture and jitter.
public struct ResizeHandle: View {
  private let width: CGFloat
  private let minimum: CGFloat
  private let maximum: CGFloat
  private let inverted: Bool
  private let onChange: (CGFloat) -> Void

  @LocalState private var active = false
  @LocalState private var startX: CGFloat?

  public init(
    width: CGFloat,
    minimum: CGFloat,
    maximum: CGFloat,
    inverted: Bool = false,
    onChange: @escaping (CGFloat) -> Void
  ) {
    self.width = width
    self.minimum = minimum
    self.maximum = maximum
    self.inverted = inverted
    self.onChange = onChange
  }

  public var body: some View {
    ZStack {
      Rectangle()
        .fill(active ? Theme.Palette.accent.opacity(0.6) : Theme.Palette.line)
        .frame(width: active ? 2 : Theme.Metric.hairline)
      Rectangle()
        .fill(Color.clear)
        .frame(width: 11)
        .contentShape(Rectangle())
    }
    .frame(width: 11)
    .onHover { hovering in
      active = hovering
      if hovering { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
    }
    .gesture(
      DragGesture(minimumDistance: 0, coordinateSpace: .global)
        .onChanged { value in
          let origin = startX ?? value.location.x
          if startX == nil { startX = origin }
          let delta = value.location.x - origin
          let target = inverted ? width - delta : width + delta
          onChange(min(max(target, minimum), maximum))
        }
        .onEnded { _ in startX = nil }
    )
    .accessibilityLabel("调整栏宽")
  }
}
