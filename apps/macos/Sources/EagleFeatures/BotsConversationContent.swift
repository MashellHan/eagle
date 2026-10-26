import EagleDesign
import SwiftUI

struct BotsConversationContent: View {
  @ObservedObject var bots: BotsWorkspaceViewModel
  @ObservedObject var layout: ShellLayoutViewModel
  @ObservedObject private var transcript: BotsTranscriptViewModel

  init(bots: BotsWorkspaceViewModel, layout: ShellLayoutViewModel) {
    self.bots = bots
    self.layout = layout
    self.transcript = bots.transcript
  }

  var body: some View {
    ConversationColumn(
      title: bots.title, subtitle: bots.subtitle, tintIndex: bots.tintIndex,
      entries: transcript.entries,
      preparedMarkdown: transcript.markdown,
      draft: Binding(get: { bots.draft }, set: { bots.setDraft($0) }),
      onSend: { bots.send() },
      showsSidebar: layout.showsSidebar, showsInspector: layout.showsInspector,
      participantStatus: bots.participantStatus,
      onStop: { bots.abort() }, onRecover: { bots.recover() },
      onDismissError: { bots.dismissError() },
      onShowSidebar: { layout.toggleSidebar() },
      onToggleInspector: { layout.toggleInspector() }
    )
    .id(bots.selectedId)
  }
}
