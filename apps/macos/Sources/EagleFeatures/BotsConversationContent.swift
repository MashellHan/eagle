import EagleDesign
import SwiftUI

struct BotsConversationContent: View {
  @ObservedObject var bots: BotsWorkspaceViewModel
  @ObservedObject var layout: ShellLayoutViewModel
  @ObservedObject private var transcript: BotsTranscriptViewModel
  @ObservedObject private var composer: BotsComposerViewModel
  @AppStorage("eagle.hideToolCalls") private var hideToolCalls = false

  init(bots: BotsWorkspaceViewModel, layout: ShellLayoutViewModel) {
    self.bots = bots
    self.layout = layout
    self.transcript = bots.transcript
    self.composer = bots.composer
  }

  var body: some View {
    ConversationColumn(
      title: bots.title, tintIndex: bots.tintIndex,
      face: bots.selectedFace,
      entries: transcript.entries,
      showsToolCalls: !hideToolCalls,
      preparedMarkdown: transcript.markdown,
      draft: Binding(get: { composer.text }, set: { bots.setDraft($0) }),
      onSend: { bots.send() },
      showsSidebar: layout.showsSidebar, showsInspector: layout.showsInspector,
      participantStatus: bots.participantStatus,
      isWaiting: bots.waiting,
      headerAccessory: historyMenu,
      composerPlaceholder: bots.displayedHistory == nil ? nil : "从此会话继续，使用本机模型",
      onStop: { bots.abort() },
      onInsert: bots.running ? { bots.send(inserting: true) } : nil,
      onRecover: { bots.recover() },
      onRetryConnection: { bots.retryConnection() },
      onDismissError: { bots.dismissError() },
      onShowSidebar: { layout.toggleSidebar() },
      onToggleInspector: { layout.toggleInspector() },
      onOpenPeerExchange: { id in Task { await bots.openExchange(id) } }
    )
    .id(bots.selectedId)
  }

  private var historyMenu: AnyView? {
    guard !bots.historyBranches.isEmpty else { return nil }
    return AnyView(
      Menu {
        Button(bots.localBranchId == nil ? "本机会话" : "本机续聊") { bots.showHistory(nil) }
        Divider()
        ForEach(Array(bots.historyBranches.enumerated()), id: \.element.id) { index, branch in
          Button("收到的会话 \(index + 1)") { bots.showHistory(branch.branchId) }
        }
      } label: {
        Label(
          bots.displayedHistory.map { $0.usable ? "收到的会话 · 可继续" : "收到的会话 · 同步中" }
            ?? (bots.localBranchId == nil ? "本机会话" : "本机续聊"),
          systemImage: "arrow.triangle.branch"
        )
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
      }
      .menuStyle(.borderlessButton)
      .labelStyle(.iconOnly)
      .frame(width: Theme.Metric.headerControlHeight)
      .fixedSize()
      .accessibilityIdentifier("bots.history.branch")
    )
  }
}
