import SwiftUI

/// Three dots rising and falling in a slow wave: the sign that a bot is working before its
/// first token lands. It sits on its own reserved band above the composer, never inside the
/// transcript, so starting and finishing cannot shift a row. Reduce Motion holds it still.
public struct TypingWaves: View {
  private let label: String

  public init(label: String = "正在输入") {
    self.label = label
  }

  public var body: some View {
    dots
      .frame(height: Theme.Metric.waitingBandHeight)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(label)
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @ViewBuilder
  private var dots: some View {
    if reduceMotion {
      row(at: 0)
    } else {
      TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
        row(at: context.date.timeIntervalSinceReferenceDate)
      }
    }
  }

  /// A 1.4 s cycle per dot, offset by a third so the three read as one travelling wave.
  private func row(at instant: TimeInterval) -> some View {
    HStack(spacing: Theme.Metric.waitingDotGap) {
      ForEach(0..<3, id: \.self) { index in
        let wave =
          reduceMotion
          ? 0 : sin(instant * 2 * .pi / 1.4 - Double(index) * 0.7)
        Circle()
          .fill(Theme.Palette.textMuted)
          .frame(width: Theme.Metric.waitingDot, height: Theme.Metric.waitingDot)
          .offset(y: -wave * Theme.Metric.waitingDotLift)
          .opacity(reduceMotion ? 0.7 : 0.45 + 0.4 * (wave + 1) / 2)
      }
    }
    .frame(height: Theme.Metric.waitingBandHeight)
  }
}
