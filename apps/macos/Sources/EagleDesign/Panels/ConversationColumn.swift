import SwiftUI

/// One transcript row. Assistant turns are plain text; only user turns and the
/// delivery meta lines carry color.
public enum TranscriptEntry: Identifiable, Hashable, Sendable {
  case assistant(id: String, blocks: [AssistantTurn.Block])
  case user(id: String, text: String)
  case note(id: String, text: String, tintIndices: [Int])
  case tool(id: String, row: ToolRow)
  case typing(id: String)

  public var id: String {
    switch self {
    case .assistant(let id, _), .user(let id, _), .note(let id, _, _), .tool(let id, _),
      .typing(let id):
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
  private let onToggleInspector: () -> Void
  private let showsSidebar: Bool
  private let showsInspector: Bool

  public init(
    title: String,
    subtitle: String,
    tintIndex: Int,
    entries: [TranscriptEntry],
    draft: Binding<String>,
    onSend: @escaping () -> Void,
    showsSidebar: Bool = true,
    showsInspector: Bool = true,
    onShowSidebar: @escaping () -> Void = {},
    onToggleInspector: @escaping () -> Void = {}
  ) {
    self.title = title
    self.subtitle = subtitle
    self.tintIndex = tintIndex
    self.entries = entries
    self._draft = draft
    self.onSend = onSend
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
    self.onShowSidebar = onShowSidebar
    self.onToggleInspector = onToggleInspector
  }

  public var body: some View {
    VStack(spacing: 0) {
      header

      transcript
        .frame(maxWidth: .infinity, maxHeight: .infinity)

      Composer(
        placeholder: "给 \(title) 发消息",
        text: $draft,
        onSend: onSend
      )
      .padding(.horizontal, Theme.Metric.conversationInset)
      .padding(.bottom, Theme.Metric.composerBottomInset)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }

  private var header: some View {
    HeaderRow {
      ZStack {
        ParticipantBubble(
          name: title,
          tintIndex: tintIndex,
          action: onToggleInspector
        )

        HStack(spacing: 8) {
          if !showsSidebar {
            IconButton(
              systemName: "sidebar.left", label: "展开侧栏", style: .circled, action: onShowSidebar)
          }
          Spacer(minLength: 0)
          if !showsInspector {
            IconButton(
              systemName: "sidebar.right", label: "展开检查器", style: .circled,
              action: onToggleInspector)
          }
        }
        .padding(
          .leading, showsSidebar ? Theme.Metric.conversationInset : Theme.Metric.trafficLightsEnd
        )
        .padding(.trailing, Theme.Metric.conversationInset)
      }
    }
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Metric.conversationInset)
        .padding(.top, 6)
        .padding(.bottom, 12)
        .animation(.easeOut(duration: 0.2), value: entries.count)
      }
      .scrollEdgeFades(
        Theme.Palette.surface, top: Theme.Metric.edgeFadeHeight, bottom: Theme.Metric.edgeFadeHeight
      )
      .onChange(of: entries.count) {
        withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("bottom", anchor: .bottom) }
      }
    }
  }

  @ViewBuilder
  private func row(_ entry: TranscriptEntry) -> some View {
    switch entry {
    case .assistant(_, let blocks):
      AssistantBubble(text: blocks.markdown)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .user(_, let text):
      UserBubble(text)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .note(_, let text, let tintIndices):
      DeliveryNote(text, avatars: tintIndices.map(Theme.Palette.avatarTint))
    case .tool(_, let row):
      ToolCallRow(row)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .typing:
      TypingIndicator()
    }
  }
}
