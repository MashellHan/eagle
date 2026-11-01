import SwiftUI

/// A bot that is working moves its own face in a slow breath: a few degrees of sway, a lift,
/// and a gentle swell. The same animation serves the sidebar row and the waiting line above
/// the composer, so "this bot is busy" looks identical wherever it is shown. Reduce Motion
/// holds the face still.
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
        let wave = wave(at: context.date)
        content
          .scaleEffect(1 + 0.055 * (wave + 1) / 2)
          .rotationEffect(.degrees(wave * 5))
          .offset(y: -wave * 1.5)
      }
    }
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// A 2.2 s breath, so the eye catches it without it ever becoming a distraction.
  private func wave(at date: Date) -> Double {
    sin(date.timeIntervalSinceReferenceDate * 2 * .pi / 2.2)
  }
}
