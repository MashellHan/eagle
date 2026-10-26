import SwiftUI

/// One transcript row. Assistant turns are plain text; only user turns and the
/// delivery meta lines carry color.
public enum TranscriptEntry: Identifiable, Hashable, Sendable {
  case assistant(id: String, blocks: [AssistantTurn.Block])
  /// The assistant turn still receiving deltas: the bubble shows a caret.
  case streamingAssistant(id: String, blocks: [AssistantTurn.Block])
  case user(id: String, text: String)
  case note(id: String, text: String, tintIndices: [Int])
  case tool(id: String, row: ToolRow)
  /// Several calls from one turn, collapsed into a single line with a detail sheet.
  case toolRun(id: String, rows: [ToolRow])
  case typing(id: String)

  public var id: String {
    switch self {
    case .assistant(let id, _), .streamingAssistant(let id, _), .user(let id, _),
      .note(let id, _, _), .tool(let id, _), .toolRun(let id, _), .typing(let id):
      return id
    }
  }

  public var isStreaming: Bool {
    if case .streamingAssistant = self { return true }
    return false
  }

  public var isToolCall: Bool {
    switch self {
    case .tool, .toolRun: return true
    default: return false
    }
  }
}

extension [TranscriptEntry] {
  /// Settings → 通用 hides tool traffic without touching the stored conversation.
  public func hidingToolCalls(_ hidden: Bool) -> [TranscriptEntry] {
    guard hidden else { return self }
    return filter { !$0.isToolCall }
  }
}

/// Middle column: a slim control strip, scrollable transcript, composer.
public struct ConversationColumn: View {
  private let title: String
  private let subtitle: String
  private let tintIndex: Int
  private let entries: [TranscriptEntry]
  private let showsToolCalls: Bool
  private let preparedMarkdown: [String: [RenderedMarkdownBlock]]
  @Binding private var draft: String
  private let onSend: () -> Void
  private let onShowSidebar: () -> Void
  private let onToggleInspector: () -> Void
  private let showsSidebar: Bool
  private let showsInspector: Bool
  private let participantStatus: ParticipantStatus?
  private let onStop: () -> Void
  private let onRecover: () -> Void
  private let onDismissError: () -> Void
  @State private var scroller = TranscriptScroller()

  public init(
    title: String,
    subtitle: String,
    tintIndex: Int,
    entries: [TranscriptEntry],
    showsToolCalls: Bool = true,
    preparedMarkdown: [String: [RenderedMarkdownBlock]] = [:],
    draft: Binding<String>,
    onSend: @escaping () -> Void,
    showsSidebar: Bool = true,
    showsInspector: Bool = true,
    participantStatus: ParticipantStatus? = nil,
    onStop: @escaping () -> Void = {},
    onRecover: @escaping () -> Void = {},
    onDismissError: @escaping () -> Void = {},
    onShowSidebar: @escaping () -> Void = {},
    onToggleInspector: @escaping () -> Void = {}
  ) {
    self.title = title
    self.subtitle = subtitle
    self.tintIndex = tintIndex
    self.entries = entries
    self.showsToolCalls = showsToolCalls
    self.preparedMarkdown = preparedMarkdown
    self._draft = draft
    self.onSend = onSend
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
    self.participantStatus = participantStatus
    self.onStop = onStop
    self.onRecover = onRecover
    self.onDismissError = onDismissError
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
      .fixedSize(horizontal: false, vertical: true)
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
          status: participantStatus,
          onStop: onStop,
          onRecover: onRecover,
          onDismissError: onDismissError,
          action: onToggleInspector
        )
        .padding(
          .horizontal,
          (showsSidebar ? Theme.Metric.conversationInset : Theme.Metric.trafficLightsEnd)
            + Theme.Metric.headerControlHeight + 8
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
        LazyVStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
          ForEach(entries.hidingToolCalls(!showsToolCalls)) { entry in
            row(entry).id(entry.id)
          }
          Color.clear.frame(height: 1).id("bottom")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Metric.conversationInset)
        // Clear of the top edge fade: the first row must not start under it.
        .padding(.top, Theme.Metric.edgeFadeHeight + 10)
        .padding(.bottom, 12)
      }
      .scrollEdgeFades(
        Theme.Palette.surface, top: Theme.Metric.edgeFadeHeight, bottom: Theme.Metric.edgeFadeHeight
      )
      .onScrollPhaseChange { _, phase in
        scroller.setUserScrolling(
          phase == .tracking || phase == .interacting || phase == .decelerating)
        if phase == .idle, scroller.endUserScroll() {
          proxy.scrollTo("bottom", anchor: .bottom)
        }
      }
      .onScrollGeometryChange(for: TranscriptScrollMetrics.self) { geometry in
        TranscriptScrollMetrics(
          contentHeight: geometry.contentSize.height, visibleBottom: geometry.visibleRect.maxY
        )
      } action: { _, metrics in
        if scroller.update(metrics) {
          proxy.scrollTo("bottom", anchor: .bottom)
        }
      }
    }
  }

  @ViewBuilder
  private func row(_ entry: TranscriptEntry) -> some View {
    switch entry {
    case .assistant(_, let blocks), .streamingAssistant(_, let blocks):
      AssistantBubble(
        text: blocks.markdown, streaming: entry.isStreaming,
        preparedBlocks: preparedMarkdown[entry.id]
      )
      .equatable()
      .transition(
        .asymmetric(
          insertion: .opacity.combined(with: .scale(scale: 0.985, anchor: .bottomLeading)),
          removal: .opacity
        )
      )
    case .user(_, let text):
      UserBubble(text)
        .transition(
          .asymmetric(
            insertion: .opacity.combined(with: .scale(scale: 0.985, anchor: .bottomTrailing)),
            removal: .opacity
          )
        )
    case .note(_, let text, let tintIndices):
      DeliveryNote(text, avatars: tintIndices.map(Theme.Palette.avatarTint))
    case .tool(_, let row):
      ToolCallRow(row)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .toolRun(_, let rows):
      ToolRunRow(rows)
        .transition(.opacity)
    case .typing:
      TypingIndicator()
    }
  }
}
