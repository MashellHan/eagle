import SwiftUI

/// One transcript row. Assistant turns are plain text; only user turns and the
/// delivery meta lines carry color.
public enum TranscriptEntry: Identifiable, Hashable, Sendable {
  case assistant(id: String, blocks: [AssistantTurn.Block])
  case user(id: String, text: String)
  case note(id: String, text: String, tintIndices: [Int])
  case typing(id: String)

  public var id: String {
    switch self {
    case .assistant(let id, _), .user(let id, _), .note(let id, _, _), .typing(let id):
      return id
    }
  }
}

/// Middle column: participant header, scrollable transcript, composer.
public struct ConversationColumn: View {
  private let title: String
  private let subtitle: String
  private let tintIndex: Int
  private let entries: [TranscriptEntry]
  @Binding private var draft: String
  private let onSend: () -> Void
  private let onShare: () -> Void
  private let onClose: () -> Void

  public init(
    title: String,
    subtitle: String,
    tintIndex: Int,
    entries: [TranscriptEntry],
    draft: Binding<String>,
    onSend: @escaping () -> Void,
    onShare: @escaping () -> Void = {},
    onClose: @escaping () -> Void = {}
  ) {
    self.title = title
    self.subtitle = subtitle
    self.tintIndex = tintIndex
    self.entries = entries
    self._draft = draft
    self.onSend = onSend
    self.onShare = onShare
    self.onClose = onClose
  }

  public var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
            ForEach(entries) { entry in
              row(entry).id(entry.id)
            }
            Color.clear.frame(height: 1).id("bottom")
          }
          .frame(maxWidth: Theme.Metric.conversationMaxContentWidth, alignment: .leading)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, Theme.Metric.conversationInset)
          .padding(.top, 18)
          .padding(.bottom, 8)
        }
        .scrollIndicators(.never)
        .onChange(of: entries.count) {
          withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
      }

      Composer(
        placeholder: "给 \(title) 发消息",
        text: $draft,
        onSend: onSend
      )
      .padding(.horizontal, Theme.Metric.conversationInset)
      .padding(.bottom, 20)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }

  @ViewBuilder
  private func row(_ entry: TranscriptEntry) -> some View {
    switch entry {
    case .assistant(_, let blocks):
      AssistantTurn(blocks)
    case .user(_, let text):
      UserBubble(text)
    case .note(_, let text, let tintIndices):
      DeliveryNote(text, avatars: tintIndices.map(Theme.Palette.avatarTint))
    case .typing:
      TypingIndicator()
    }
  }
}
