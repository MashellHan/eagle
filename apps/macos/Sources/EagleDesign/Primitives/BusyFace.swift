import SwiftUI

/// A bot that is answering turns its own face a few degrees around the centre, forever: a calm
/// sign of work instead of a "working" tag. Reduce Motion holds the face still.
public struct BusyFace<Content: View>: View {
  private let content: Content

  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  public var body: some View {
    if reduceMotion {
      content
    } else {
      TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { context in
        content.rotationEffect(.degrees(angle(at: context.date)))
      }
    }
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// A 2.6 s cycle that never rests at a hard edge, so the motion reads as breathing.
  private func angle(at date: Date) -> Double {
    let seconds = date.timeIntervalSinceReferenceDate
    return sin(seconds * 2 * .pi / 2.6) * 11
  }
}
