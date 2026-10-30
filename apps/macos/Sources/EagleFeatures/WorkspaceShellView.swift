import AppKit
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
  @StateObject private var daemon = BotsDaemonSupervisor.shared
  @StateObject private var devices = DeviceSettingsViewModel.shared
  @StateObject private var bots = BotsWorkspaceViewModel()
  @StateObject private var chrome = SidebarChromeViewModel()
  @State private var showsAccountMenu = false
  @State private var showsBotCreate = false
  @State private var showsBotFaceEditor = false
  @AppStorage("eagle.appearance") private var appearance = "system"
  @AppStorage("eagle.hideToolCalls") private var hideToolCalls = false
  @AppStorage("eagle.loadMockData") private var loadMockData = false
  private let onShowGallery: (@escaping () -> Void) -> Void

  public init(
    list: WorkspaceListViewModel = WorkspaceListViewModel(),
    chat: BotChatViewModel = BotChatViewModel(),
    inspector: InspectorViewModel = InspectorViewModel(),
    layout: ShellLayoutViewModel = ShellLayoutViewModel(),
    onShowGallery: @escaping (@escaping () -> Void) -> Void = { _ in }
  ) {
    _list = StateObject(wrappedValue: list)
    _chat = StateObject(wrappedValue: chat)
    _inspector = StateObject(wrappedValue: inspector)
    _layout = StateObject(wrappedValue: layout)
    self.onShowGallery = onShowGallery
  }

  private var sidebarSections: [SidebarSection] {
    SidebarComposition.sections(
      botSections: bots.sections,
      mock: list.sections,
      showsMock: loadMockData
    )
    .map(chrome.decorate)
  }

  /// Identifiers that belong to the sample workspace, so switching it off drops them.
  private var mockIDs: Set<String> {
    Set(list.groups.flatMap(\.items).map(\.id))
  }

  private func dropSampleSelectionIfHidden() {
    guard
      !SidebarComposition.keepsSelection(list.selection, mockIDs: mockIDs, showsMock: loadMockData)
    else { return }
    list.selection = nil
  }

  private var moveGroups: [SidebarItemGroup] {
    list.groups.map { SidebarItemGroup(id: $0.id, title: $0.title) }
  }

  /// A real bot moves between the daemon's groups (plus 未分组); a sample row moves between
  /// the sample groups.
  private func moveTargets(for id: String) -> [SidebarItemGroup] {
    guard bots.owns(id) else { return moveGroups }
    var targets = bots.groups.map { SidebarItemGroup(id: $0.id, title: $0.title) }
    // A grouped bot can always be unfiled, even while no 未分组 section is on screen yet.
    if bots.groupId(of: id) != nil {
      targets.append(
        SidebarItemGroup(id: SidebarComposition.ungroupedSectionID, title: "未分组"))
    }
    return targets
  }

  private func moveItem(_ id: String, to groupId: String?) {
    guard bots.owns(id) else { return }
    let target = groupId == SidebarComposition.ungroupedSectionID ? nil : groupId
    Task { await bots.moveBot(id, toGroup: target) }
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

  /// The sample transcript is only reachable while the sample data is switched on.
  private var selectedIsMock: Bool {
    loadMockData && list.selection != nil && !selectedIsBot
  }

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
          onToggleSection: { id in
            if bots.ownsSection(id) {
              bots.toggleSection(id)
            } else {
              list.toggleSection(id)
            }
          },
          onRenameSection: { id, title in
            if bots.ownsSection(id) {
              Task { await bots.renameGroup(id, to: title) }
            } else {
              list.renameSection(id, to: title)
            }
          },
          onDeleteSection: { id in
            if bots.ownsSection(id) {
              Task { await bots.deleteGroup(id) }
            } else {
              list.deleteSection(id)
            }
          },
          onCreateSection: { list.createSection() },
          onCreateGroup: { Task { await bots.createGroup() } },
          onCreateBot: { showsBotCreate = true },
          canCreateBot: bots.isConnected,
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
          onCollapse: { layout.toggleSidebar() },
          onAccount: { showsAccountMenu = true },
          onGallery: { onShowGallery { showSettings() } },
          onPinItem: { id in chrome.togglePin(id) },
          moveTargets: { id in moveTargets(for: id) },
          onToggleItem: { id in
            if bots.owns(id) { bots.toggleTrigger(id) }
          },
          onMoveItem: { id, groupId in
            if bots.owns(id) {
              moveItem(id, to: groupId)
            } else if let groupId {
              list.moveItem(id, to: groupId)
            }
          },
          onMarkUnread: { id in chrome.markUnread(id) },
          onCopyId: { id in chrome.copyId(id) },
          onHideItem: { id in
            chrome.hide(id)
            selectAfterHide(id)
          },
          onMoveGroup: { id, offset in
            Task { await bots.reorderGroups(moving: id, by: offset) }
          }
        )
      } conversation: {
        VStack(spacing: 0) {
          if selectedIsBot && bots.needsModelSetup {
            BotsModelSetupBanner(
              onOpen: { bots.onOpenSettings?() },
              onDismiss: { bots.dismissModelSetup() }
            )
          }
          if selectedIsBot {
            BotsConversationContent(bots: bots, layout: layout)
          } else if selectedIsMock {
            ConversationColumn(
              title: item?.title ?? "依赖修复专家",
              subtitle: item?.tag ?? "GitHub",
              tintIndex: item?.tintIndex ?? 2,
              entries: chat.entries,
              showsToolCalls: !hideToolCalls,
              draft: $chat.draft,
              onSend: { chat.send() },
              showsSidebar: layout.showsSidebar,
              showsInspector: layout.showsInspector,
              onShowSidebar: { layout.toggleSidebar() },
              onToggleInspector: { layout.toggleInspector() }
            )
          } else {
            NoConversationPlaceholder(
              onCreate: { showsBotCreate = true },
              onShowSidebar: { layout.toggleSidebar() },
              showsSidebar: layout.showsSidebar,
              daemonMessage: bots.error,
              onRetry: bots.error == nil ? nil : { Task { await bots.retryConnectionAsync() } }
            )
          }
        }
      } inspector: {
        InspectorColumn(
          name: selectedIsBot ? bots.title : (selectedIsMock ? (item?.title ?? "示例") : "未选择"),
          subtitle: selectedIsBot ? "Bots" : (selectedIsMock ? (item?.tag ?? "示例") : ""),
          tintIndex: selectedIsBot ? bots.tintIndex : (item?.tintIndex ?? 2),
          width: layout.inspectorWidth,
          artifacts: selectedIsMock ? inspector.artifacts : [],
          jobs: selectedIsMock ? inspector.jobs : [],
          tasks: selectedIsBot ? bots.tasks : [],
          usage: selectedIsBot ? bots.usage : [],
          choices: selectedIsBot ? bots.choices : [],
          triggers: selectedIsBot ? bots.triggerRows : [],
          onChoose: { row, value in
            guard selectedIsBot else { return }
            Task { await bots.choose(row, value: value) }
          },
          tab: $inspector.tab,
          onToggleJob: { inspector.setJob($0, isOn: $1) },
          onRetryTask: { id in
            guard selectedIsBot else { return }
            Task { await bots.retryTask(id) }
          },
          onStopTask: { id in
            guard selectedIsBot else { return }
            Task { await bots.stopTask(id) }
          },
          onCollapse: { layout.toggleInspector() },
          face: selectedIsBot ? bots.selectedFace : nil,
          label: selectedIsBot ? bots.selectedLabel : nil,
          onEditFace: selectedIsBot ? { showsBotFaceEditor = true } : nil,
          onCommitName: selectedIsBot
            ? { title in Task { await bots.updateSelected(title: title) } } : nil,
          onCommitLabel: selectedIsBot
            ? { label in Task { await bots.updateSelected(label: label) } } : nil,
          computerContent: AnyView(
            DeviceInspectorView(model: devices) {
              settings.selection = .machines
              showSettings()
            })
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
          showSettings()
        }
        await daemon.startIfNeeded()
      }
      .task(id: daemon.status) {
        // Every window follows readiness, including a shared start or a Settings retry.
        guard case .running = daemon.status else {
          bots.disconnect()
          return
        }
        await bots.start()
        guard !Task.isCancelled else { return }
        await bots.loadModels()
      }
      .task { await devices.observe() }
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
      .onChange(of: loadMockData) { _, _ in dropSampleSelectionIfHidden() }
      .task { dropSampleSelectionIfHidden() }
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
          if row.id == "settings" { showSettings() }
        }
        .padding(.leading, Theme.Metric.contentInset)
        .padding(.bottom, Theme.Metric.footerHeight + Theme.Metric.footerBottom + 6)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
    }
    .animation(.snappy(duration: 0.18), value: showsAccountMenu)
    .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSettings)) { _ in
      showSettings()
    }
    .sheet(
      isPresented: Binding(
        get: { devices.pendingApproval != nil },
        set: { if !$0 { devices.denyPendingApproval() } })
    ) {
      DeviceApprovalView(model: devices)
    }
    .onChange(of: devices.pendingApproval?.id) { _, value in
      if value != nil { NSApp.activate(ignoringOtherApps: true) }
    }
  }

  private func showSettings() {
    SettingsWindowController.shared.show(model: settings, daemon: daemon, devices: devices)
  }
}
