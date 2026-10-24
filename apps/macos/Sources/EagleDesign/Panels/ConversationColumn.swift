import SwiftUI

/// One transcript row. Assistant turns are plain text; only user turns and the
/// delivery meta lines carry color.
public struct TranscriptSender: Hashable, Sendable {
  public let name: String
  public let tintIndex: Int

  public init(name: String, tintIndex: Int) {
    self.name = name
    self.tintIndex = tintIndex
  }
}

public enum TranscriptEntry: Identifiable, Hashable, Sendable {
  case assistant(id: String, blocks: [AssistantTurn.Block], sender: TranscriptSender? = nil)
  case user(id: String, text: String)
  case note(id: String, text: String, tintIndices: [Int])
  case typing(id: String)

  public var id: String {
    switch self {
    case .assistant(let id, _, _), .user(let id, _), .note(let id, _, _), .typing(let id):
      return id
    }
  }
}

/// Middle column: a slim control strip, scrollable transcript, composer.
public struct ConversationColumn: View {
  private let title: String
  private let subtitle: String
  private let tintIndex: Int
  private let entries: [TranscriptEntry]
  @Binding private var draft: String
  private let onSend: () -> Void
  private let onShowSidebar: () -> Void
  private let showsSidebar: Bool

  public init(
    title: String,
    subtitle: String,
    tintIndex: Int,
    entries: [TranscriptEntry],
    draft: Binding<String>,
    onSend: @escaping () -> Void,
    showsSidebar: Bool = true,
    onShowSidebar: @escaping () -> Void = {}
  ) {
    self.title = title
    self.subtitle = subtitle
    self.tintIndex = tintIndex
    self.entries = entries
    self._draft = draft
    self.onSend = onSend
    self.showsSidebar = showsSidebar
    self.onShowSidebar = onShowSidebar
  }

  public var body: some View {
    VStack(spacing: 0) {
      if !showsSidebar {
        controlStrip
      }

      ZStack(alignment: .top) {
        transcript
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)

      Composer(
        placeholder: "给 \(title) 发消息",
        text: $draft,
        onSend: onSend
      )
      .padding(.horizontal, Theme.Metric.conversationInset)
      .padding(.bottom, Theme.Metric.composerBottomInset + Theme.Metric.windowInset)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }

  private var controlStrip: some View {
    HStack(spacing: 10) {
      if !showsSidebar {
        IconButton(systemName: "sidebar.left", label: "展开侧栏", action: onShowSidebar)
        Avatar(initial: String(title.prefix(1)), tint: Theme.Palette.avatarTint(tintIndex), size: 24)
        Text(title)
          .font(Theme.TypeScale.cardTitle)
          .foregroundStyle(Theme.Palette.textSecondary)
          .transition(.opacity)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Theme.Metric.conversationInset - 8)
    .padding(.top, Theme.Metric.windowInset + 2)
    .frame(height: Theme.Metric.windowInset + 40)
  }

  private var transcript: some View {
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
        .padding(.top, showsSidebar ? Theme.Metric.windowInset + 6 : 6)
        .padding(.bottom, 12)
        .animation(.easeOut(duration: 0.2), value: entries.count)
      }
      .scrollEdgeFades(Theme.Palette.surface)
      .onChange(of: entries.count) {
        withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("bottom", anchor: .bottom) }
      }
    }
  }

  @ViewBuilder
  private func row(_ entry: TranscriptEntry) -> some View {
    switch entry {
    case .assistant(_, let blocks, let sender):
      VStack(alignment: .leading, spacing: 14) {
        if let sender {
          HStack {
            Spacer(minLength: 0)
            SenderChip(name: sender.name, tintIndex: sender.tintIndex)
          }
        }
        AssistantTurn(blocks)
      }
      .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .user(_, let text):
      UserBubble(text)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .note(_, let text, let tintIndices):
      DeliveryNote(text, avatars: tintIndices.map(Theme.Palette.avatarTint))
    case .typing:
      TypingIndicator()
    }
  }
}
