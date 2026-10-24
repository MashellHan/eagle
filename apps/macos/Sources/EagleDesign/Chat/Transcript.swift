import SwiftUI

/// A single assistant turn: plain text on the surface, never a bubble.
/// Bullets keep the reference's tight left column.
public struct AssistantTurn: View {
  public enum Block: Hashable, Sendable {
    case paragraph(String)
    case bullets([String])
    case note(String)
  }

  private let blocks: [Block]

  public init(_ blocks: [Block]) {
    self.blocks = blocks
  }

  public init(text: String) {
    self.blocks = [.paragraph(text)]
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        switch block {
        case .paragraph(let text):
          Text(text)
            .font(Theme.TypeScale.body)
            .foregroundStyle(Theme.Palette.textPrimary)
            .lineSpacing(4)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        case .bullets(let items):
          VStack(alignment: .leading, spacing: 5) {
            ForEach(items, id: \.self) { item in
              HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•")
                  .font(Theme.TypeScale.body)
                  .foregroundStyle(Theme.Palette.textSecondary)
                Text(item)
                  .font(Theme.TypeScale.body)
                  .foregroundStyle(Theme.Palette.textPrimary)
                  .textSelection(.enabled)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
          }
        case .note(let text):
          Text(text)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The only colored surface in the transcript: a green pill aligned right.
public struct UserBubble: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    HStack {
      Spacer(minLength: 96)
      Text(text)
        .font(Theme.TypeScale.bubble)
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .background(Capsule().fill(Theme.Palette.accentFill))
        .textSelection(.enabled)
    }
  }
}

/// Centered meta line between turns, with optional participant avatars.
public struct DeliveryNote: View {
  private let text: String
  private let avatars: [Color]

  public init(_ text: String, avatars: [Color] = []) {
    self.text = text
    self.avatars = avatars
  }

  public var body: some View {
    HStack(spacing: 6) {
      Spacer(minLength: 0)
      ForEach(Array(avatars.enumerated()), id: \.offset) { index, tint in
        Avatar(initial: "", tint: tint, size: Theme.Metric.avatarNote)
          .overlay(alignment: .center) {
            Image(systemName: index % 2 == 0 ? "person.fill" : "sparkle")
              .font(.system(size: 7, weight: .bold))
              .foregroundStyle(.white)
          }
      }
      Text(text)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}

/// `正在输入...` row with the small green arc from the reference.
public struct TypingIndicator: View {
  private let text: String

  public init(_ text: String = "正在输入...") {
    self.text = text
  }

  public var body: some View {
    HStack(spacing: 9) {
      SpinnerArc(size: 13, lineWidth: 1.8)
      Text(text)
        .font(Theme.TypeScale.body)
        .foregroundStyle(Theme.Palette.textSecondary)
      Spacer(minLength: 0)
    }
    .accessibilityLabel(text)
  }
}
