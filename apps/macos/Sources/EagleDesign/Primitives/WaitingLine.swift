import SwiftUI

/// The line above the composer while a bot works with nothing to show yet: the bot's own face,
/// breathing exactly like its busy sidebar row, and a label that swaps between `正在输入` and
/// three travelling dots. It sits on a band whose height is always reserved, so work starting
/// and settling never moves a message or the composer.
public struct WaitingLine: View {
  private let face: BotFace.Style?
  private let tintIndex: Int
  private let initial: String

  public init(face: BotFace.Style? = nil, tintIndex: Int = 0, initial: String = "") {
    self.face = face
    self.tintIndex = tintIndex
    self.initial = initial
  }

  public var body: some View {
    HStack(spacing: 9) {
      BusyFace { avatar }
      label
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
    }
    .frame(height: Theme.Metric.waitingBandHeight)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("正在输入")
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var avatar: some View {
    Group {
      if let face {
        BotFace(style: face, size: Theme.Metric.waitingAvatar)
      } else {
        Avatar(
          initial: initial, tint: Theme.Palette.avatarTint(tintIndex),
          size: Theme.Metric.waitingAvatar, shape: .blob)
      }
    }
  }

  /// The word and the dots share one slot: the wider of the two sets the width, so the swap
  /// never nudges anything beside it.
  @ViewBuilder
  private var label: some View {
    if reduceMotion {
      HStack(spacing: 6) {
        Text("正在输入")
        dots(at: 0)
      }
    } else {
      TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
        let instant = context.date.timeIntervalSinceReferenceDate
        let word = wordWeight(instant)
        ZStack(alignment: .leading) {
          Text("正在输入").opacity(word)
          dots(at: instant).opacity(1 - word)
        }
      }
    }
  }

  /// 3.4 s of cycle: the word holds, crosses out over 0.2 s, the dots travel, then the word
  /// crosses back in.
  private func wordWeight(_ instant: TimeInterval) -> Double {
    let phase = instant.truncatingRemainder(dividingBy: 3.4)
    switch phase {
    case ..<1.9: return 1
    case ..<2.1: return (2.1 - phase) / 0.2
    case ..<3.2: return 0
    default: return (phase - 3.2) / 0.2
    }
  }

  private func dots(at instant: TimeInterval) -> some View {
    HStack(spacing: Theme.Metric.waitingDotGap) {
      ForEach(0..<3, id: \.self) { index in
        let wave =
          reduceMotion
          ? 0 : sin(instant * 2 * .pi / 1.4 - Double(index) * 0.7)
        Circle()
          .fill(Theme.Palette.textMuted)
          .frame(width: Theme.Metric.waitingDot, height: Theme.Metric.waitingDot)
          .offset(y: -wave * Theme.Metric.waitingDotLift)
      }
    }
    .frame(width: 3 * Theme.Metric.waitingDot + 2 * Theme.Metric.waitingDotGap)
  }
}
