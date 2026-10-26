import EagleDesign
import SwiftUI

/// Composes the three columns with their view models. This is the only place
/// where design components and feature state meet.
public struct WorkspaceShellView: View {
  @StateObject private var list: WorkspaceListViewModel
  @StateObject private var chat: BotChatViewModel
  @StateObject private var inspector: InspectorViewModel
  @StateObject private var layout: ShellLayoutViewModel
  @StateObject private var account = AccountMenuViewModel()
  @StateObject private var settings = SettingsViewModel()
  @StateObject private var daemon = BotsDaemonSupervisor()
  @StateObject private var bots = BotsWorkspaceViewModel()
  @StateObject private var chrome = SidebarChromeViewModel()
  @State private var showsAccountMenu = false
  @State private var showsBotCreate = false
  @State private var showsBotFaceEditor = false
  @State private var showsSettings = false
  @AppStorage("eagle.appearance") private var appearance = "system"

  public init(
    list: WorkspaceListViewModel = WorkspaceListViewModel(),
    chat: BotChatViewModel = BotChatViewModel(),
    inspector: InspectorViewModel = InspectorViewModel(),
    layout: ShellLayoutViewModel = ShellLayoutViewModel()
  ) {
    _list = StateObject(wrappedValue: list)
    _chat = StateObject(wrappedValue: chat)
    _inspector = StateObject(wrappedValue: inspector)
    _layout = StateObject(wrappedValue: layout)
  }

  private var sidebarSections: [SidebarSection] {
    let base = bots.section.map { [$0] + list.sections } ?? list.sections
    return base.map(chrome.decorate)
  }

  private var moveGroups: [SidebarItemGroup] {
    list.groups.map { SidebarItemGroup(id: $0.id, title: $0.title) }
  }

  private func selectAfterHide(_ id: String) {
    guard list.selection == id else { return }
    guard let next = sidebarSections.flatMap(\.items).first?.id else {
      list.selection = nil
      return
    }
    // Hiding the open bot must move the conversation too, not only the sidebar's
    // highlight.
    if bots.owns(next) {
      bots.select(next)
    } else {
      list.selection = next
    }
  }

  private var selectedIsBot: Bool { bots.owns(list.selection) }

  public var body: some View {
    let item = list.selectedItem
    ZStack(alignment: .bottomLeading) {
      ThreeColumnShell(
        showsSidebar: layout.showsSidebar,
        showsInspector: layout.showsInspector,
        sidebarWidth: layout.sidebarWidth,
        inspectorWidth: layout.inspectorWidth,
        onResizeSidebar: { layout.setSidebarWidth($0) },
        onResizeInspector: { layout.setInspectorWidth($0) }
      ) {
        SidebarPanel(
          sections: sidebarSections,
          selection: list.selection,
          width: layout.sidebarWidth,
          onSelect: { id in
            chrome.markRead(id)
            if bots.owns(id) {
              bots.select(id)
              list.selection = id
            } else {
              list.select(id)
            }
          },
          onToggleSection: { list.toggleSection($0) },
          onRenameSection: { list.renameSection($0, to: $1) },
          onDeleteSection: { list.deleteSection($0) },
          onCreateSection: { list.createSection() },
          onRenameItem: { id, title in
            if bots.owns(id) {
              Task { await bots.rename(id, to: title) }
            } else {
              list.renameItem(id, to: title)
            }
          },
          onDeleteItem: { id in
            if bots.owns(id) {
              Task { await bots.remove(id) }
            } else {
              list.deleteItem(id)
            }
          },
          onCompose: {
            if bots.isConnected {
              showsBotCreate = true
            } else {
              list.createSection()
            }
          },
          onCollapse: { layout.toggleSidebar() },
          onAccount: { showsAccountMenu = true },
          unreadCount: 2,
          onPinItem: { id in chrome.togglePin(id) },
          onMoveItem: { id, groupId in list.moveItem(id, to: groupId) },
          onMarkUnread: { id in chrome.markUnread(id) },
          onCopyId: { id in chrome.copyId(id) },
          onHideItem: { id in
            chrome.hide(id)
            selectAfterHide(id)
          },
          moveGroups: moveGroups,
          groupOf: { id in list.groupID(of: id) },
          onCreateGroup: { list.addGroup() }
        )
      } conversation: {
        VStack(spacing: 0) {
          if selectedIsBot && bots.needsModelSetup {
            BotsModelSetupBanner(
              onOpen: { bots.onOpenSettings?() },
              onDismiss: { bots.dismissModelSetup() }
            )
          }
          ConversationColumn(
            title: selectedIsBot ? bots.title : (item?.title ?? "依赖修复专家"),
            subtitle: selectedIsBot ? bots.subtitle : (item?.tag ?? "GitHub"),
            tintIndex: selectedIsBot ? bots.tintIndex : (item?.tintIndex ?? 2),
            entries: selectedIsBot ? bots.entries : chat.entries,
            // One draft: the conversation view model owns the composer, so a refusal's
            // restored text and a queued send are the same value the user sees.
            draft: selectedIsBot
              ? Binding(get: { bots.draft }, set: { bots.setDraft($0) })
              : $chat.draft,
            onSend: { selectedIsBot ? bots.send() : chat.send() },
            showsSidebar: layout.showsSidebar,
            showsInspector: layout.showsInspector,
            participantStatus: selectedIsBot ? bots.participantStatus : nil,
            onStop: { bots.abort() },
            onRecover: { bots.recover() },
            onDismissError: { bots.dismissError() },
            onShowSidebar: { layout.toggleSidebar() },
            onToggleInspector: { layout.toggleInspector() }
          )
        }
      } inspector: {
        InspectorColumn(
          name: selectedIsBot ? bots.title : (item?.title ?? "依赖修复专家"),
          subtitle: selectedIsBot ? "Bots" : (item?.tag ?? "GitHub"),
          tintIndex: selectedIsBot ? bots.tintIndex : (item?.tintIndex ?? 2),
          width: layout.inspectorWidth,
          artifacts: selectedIsBot ? [] : inspector.artifacts,
          jobs: selectedIsBot ? [] : inspector.jobs,
          tab: $inspector.tab,
          onToggleJob: { inspector.setJob($0, isOn: $1) },
          onCollapse: { layout.toggleInspector() },
          face: selectedIsBot ? bots.selectedFace : nil,
          label: selectedIsBot ? bots.selectedLabel : nil,
          onEditFace: selectedIsBot ? { showsBotFaceEditor = true } : nil,
          onCommitName: selectedIsBot
            ? { title in Task { await bots.updateSelected(title: title) } } : nil,
          onCommitLabel: selectedIsBot
            ? { label in Task { await bots.updateSelected(label: label) } } : nil
        )
        .sheet(isPresented: $showsBotFaceEditor) {
          if let face = bots.selectedFace {
            BotFaceEditorSheet(
              initial: face,
              onSave: { appearance in
                showsBotFaceEditor = false
                Task { await bots.updateSelected(appearance: appearance) }
              },
              onCancel: { showsBotFaceEditor = false }
            )
          }
        }
      }
      .task {
        bots.onSelect = { id in list.selection = id }
        bots.onOpenSettings = {
          settings.selection = .bots
          showsSettings = true
        }
        // The daemon is a prerequisite of the Bots connection, not of the window.
        await daemon.startIfNeeded()
        await bots.start()
      }
      .onDisappear {
        // Closing the window must release the bot's connection, or its subscriber slot
        // stays taken for as long as the process lives.
        bots.disconnect()
      }
      .sheet(isPresented: $showsBotCreate) {
        BotCreateSheet(
          onCreate: { title, label, appearance in
            showsBotCreate = false
            Task { await bots.createBot(title: title, label: label, appearance: appearance) }
          },
          onCancel: { showsBotCreate = false }
        )
      }
      .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSidebar)) { _ in
        layout.toggleSidebar()
      }
      .onReceive(NotificationCenter.default.publisher(for: .eagleToggleInspector)) { _ in
        layout.toggleInspector()
      }

      if showsAccountMenu {
        Color.black.opacity(0.001)
          .ignoresSafeArea()
          .onTapGesture { showsAccountMenu = false }
        AccountMenu(rows: account.rows) { row in
          showsAccountMenu = false
          if row.id == "settings" { showsSettings = true }
        }
        .padding(.leading, Theme.Metric.contentInset)
        .padding(.bottom, Theme.Metric.footerHeight + Theme.Metric.footerBottom + 6)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
    }
    .animation(.snappy(duration: 0.18), value: showsAccountMenu)
    // A small blur under the settings card: the window stays recognisable, only softened.
    .blur(radius: showsSettings ? 5 : 0)
    .animation(.easeOut(duration: 0.18), value: showsSettings)
    .overlay {
      if showsSettings {
        settingsOverlay
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSettings)) { _ in
      showsSettings.toggle()
    }
  }

  /// Centred settings card over a blurred, dimmed copy of the window. The
  /// traffic lights are hidden while it is open so the card owns the chrome.
  private var settingsOverlay: some View {
    ZStack {
      // The blur lives on the window itself (a few points); this layer only dims.
      Color.black.opacity(0.32)
        .ignoresSafeArea()
        .onTapGesture { showsSettings = false }

      SettingsView(model: settings, onClose: { showsSettings = false }, daemon: daemon)
        .frame(width: Theme.Metric.settingsWidth, height: Theme.Metric.settingsHeight)
        .background(
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(Theme.Palette.surface)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
        .shadow(color: .black.opacity(0.28), radius: 40, y: 18)
        .background(TrafficLights(hidden: true))
    }
    .transition(.opacity)
  }
}
