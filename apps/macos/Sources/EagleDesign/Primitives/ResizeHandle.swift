import AppKit
import SwiftUI

/// One-pixel divider that drags a column width. It reports the *absolute* width
/// from the drag origin measured in the global coordinate space, so the layout
/// cannot feed back into the gesture and jitter. The line never changes colour;
/// only the cursor changes, through a native cursor rect.
public struct ResizeHandle: View {
  private let width: CGFloat
  private let minimum: CGFloat
  private let maximum: CGFloat
  private let inverted: Bool
  private let onChange: (CGFloat) -> Void

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
        .fill(Theme.Palette.line)
        .frame(width: Theme.Metric.hairline)
      Color.clear
        .contentShape(Rectangle())
        .background(CursorRect(cursor: .resizeLeftRight))
    }
    .frame(width: 11)
    .frame(maxHeight: .infinity)
    .gesture(
      DragGesture(minimumDistance: 0, coordinateSpace: .global)
        .onChanged { value in
          let origin = startX ?? value.location.x
          if startX == nil { startX = origin }
          let delta = value.location.x - origin
          let target = inverted ? width - delta : width + delta
          onChange(min(target, maximum).clamped(to: minimum...maximum))
        }
        .onEnded { _ in startX = nil }
    )
    .accessibilityLabel("调整栏宽")
  }
}

extension CGFloat {
  fileprivate func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
    Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
  }
}

/// Native cursor rect: `onHover` plus `NSCursor.push` loses to SwiftUI's own
/// cursor management, a cursor rect does not.
struct CursorRect: NSViewRepresentable {
  let cursor: NSCursor

  func makeNSView(context: Context) -> CursorView {
    CursorView(cursor: cursor)
  }

  func updateNSView(_ view: CursorView, context: Context) {
    view.cursor = cursor
    view.window?.invalidateCursorRects(for: view)
  }

  final class CursorView: NSView {
    var cursor: NSCursor

    init(cursor: NSCursor) {
      self.cursor = cursor
      super.init(frame: .zero)
      translatesAutoresizingMaskIntoConstraints = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) is not used")
    }

    override func resetCursorRects() {
      addCursorRect(bounds, cursor: cursor)
    }
  }
}
