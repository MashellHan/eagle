import SwiftUI

/// Left column: window actions, organization header, collapsible groups with
/// context-menu editing, unread pill and the current user row.
public struct SidebarPanel: View {
  private let profileInitial: String
  private let profileName: String
  private let profilePlan: String
  private let sections: [SidebarSection]
  private let selection: String?
  private let onSelect: (String) -> Void
  private let onToggleSection: (String) -> Void
  private let onRenameSection: (String, String) -> Void
  private let onDeleteSection: (String) -> Void
  private let onCreateSection: () -> Void
  private let onRenameItem: (String, String) -> Void
  private let onDeleteItem: (String) -> Void
  private let onSearch: () -> Void
  private let onCompose: () -> Void
  private let onCollapse: () -> Void
  private let unreadCount: Int
  private let onUnread: () -> Void
  private let userName: String
  private let reservesTrafficLights: Bool
  private let width: CGFloat

  @LocalState private var editingSection: String?
  @LocalState private var editingItem: String?
  @LocalState private var draftTitle = ""

  public init(
    profileInitial: String,
    profileName: String,
    profilePlan: String,
    sections: [SidebarSection],
    selection: String?,
    width: CGFloat = Theme.Metric.sidebarWidth,
    onSelect: @escaping (String) -> Void,
    onToggleSection: @escaping (String) -> Void = { _ in },
    onRenameSection: @escaping (String, String) -> Void = { _, _ in },
    onDeleteSection: @escaping (String) -> Void = { _ in },
    onCreateSection: @escaping () -> Void = {},
    onRenameItem: @escaping (String, String) -> Void = { _, _ in },
    onDeleteItem: @escaping (String) -> Void = { _ in },
    onSearch: @escaping () -> Void = {},
    onCompose: @escaping () -> Void = {},
    onCollapse: @escaping () -> Void = {},
    unreadCount: Int = 0,
    onUnread: @escaping () -> Void = {},
    userName: String = "Zheng Li",
    reservesTrafficLights: Bool = true
  ) {
    self.profileInitial = profileInitial
    self.profileName = profileName
    self.profilePlan = profilePlan
    self.sections = sections
    self.selection = selection
    self.width = width
    self.onSelect = onSelect
    self.onToggleSection = onToggleSection
    self.onRenameSection = onRenameSection
    self.onDeleteSection = onDeleteSection
    self.onCreateSection = onCreateSection
    self.onRenameItem = onRenameItem
    self.onDeleteItem = onDeleteItem
    self.onSearch = onSearch
    self.onCompose = onCompose
    self.onCollapse = onCollapse
    self.unreadCount = unreadCount
    self.onUnread = onUnread
    self.userName = userName
    self.reservesTrafficLights = reservesTrafficLights
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      profile

      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(sections) { section in
              sectionHeader(section)
              if section.isExpanded {
                ForEach(section.items) { item in
                  row(item)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
              }
            }
          }
          .padding(.horizontal, Theme.Metric.sidebarInset - Theme.Metric.rowInset)
          .padding(.bottom, 12)
        }
        .scrollIndicators(.never)
        .scrollEdgeFades(Theme.Palette.canvas, top: 18, bottom: 18)
        .overlay(alignment: .bottom) { unreadPill }
        .onChange(of: selection) {
          if let selection {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(selection, anchor: .center) }
          }
        }
      }

      footer
    }
    .frame(width: width)
    .frame(maxHeight: .infinity)
    .background(Theme.Palette.canvas)
  }

  private var header: some View {
    HStack(spacing: 2) {
      IconButton(systemName: "sidebar.left", label: "收起侧栏", action: onCollapse)
      Spacer(minLength: 0)
      IconButton(systemName: "magnifyingglass", label: "搜索", action: onSearch)
      IconButton(systemName: "plus", label: "新建会话", action: onCompose)
      Menu {
        Button("新建分组", action: onCreateSection)
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: Theme.Metric.iconButton * 0.42, weight: .medium))
          .foregroundStyle(Theme.Palette.textSecondary)
          .frame(width: Theme.Metric.iconButton, height: Theme.Metric.iconButton)
          .contentShape(Rectangle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .frame(width: Theme.Metric.iconButton)
      .accessibilityLabel("更多操作")
    }
    .padding(.horizontal, Theme.Metric.sidebarInset - 8)
    .padding(.top, reservesTrafficLights ? Theme.Metric.trafficLightInset : 6)
  }

  private func sectionHeader(_ section: SidebarSection) -> some View {
    HStack(spacing: 6) {
      Button {
        withAnimation(.snappy(duration: 0.22)) { onToggleSection(section.id) }
      } label: {
        HStack(spacing: 5) {
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(Theme.Palette.textSecondary.opacity(0.8))
            .rotationEffect(.degrees(section.isExpanded ? 90 : 0))
          if editingSection == section.id {
            TextField("", text: $draftTitle)
              .textFieldStyle(.plain)
              .font(Theme.TypeScale.sectionLabel)
              .foregroundStyle(Theme.Palette.textPrimary)
              .onSubmit { commitSectionRename(section.id) }
          } else {
            SectionLabel(section.title, count: section.count)
          }
        }
      }
      .buttonStyle(.plain)
      .contextMenu {
        Button("重命名") { beginSectionRename(section) }
        Button("新建分组", action: onCreateSection)
        Divider()
        Button("删除分组", role: .destructive) { onDeleteSection(section.id) }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Theme.Metric.rowInset)
    .frame(height: Theme.Metric.sectionHeaderHeight)
    .padding(.top, Theme.Metric.sectionGap)
    .animation(.easeOut(duration: 0.12), value: section.isExpanded)
  }

  private func row(_ item: SidebarItem) -> some View {
    Button {
      withAnimation(.easeOut(duration: 0.16)) { onSelect(item.id) }
    } label: {
      if editingItem == item.id {
        TextField("", text: $draftTitle)
          .textFieldStyle(.plain)
          .font(Theme.TypeScale.rowTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
          .padding(.horizontal, Theme.Metric.rowInset)
          .frame(height: Theme.Metric.rowHeight)
          .background(
            RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
              .fill(Theme.Palette.card)
          )
          .onSubmit { commitItemRename(item.id) }
      } else {
        ConversationRow(item: item, selected: item.id == selection)
      }
    }
    .buttonStyle(.plain)
    .id(item.id)
    .contextMenu {
      Button("重命名") { beginItemRename(item) }
      Divider()
      Button("删除对话", role: .destructive) { onDeleteItem(item.id) }
    }
  }

  @ViewBuilder
  private var unreadPill: some View {
    if unreadCount > 0 {
      Button(action: onUnread) {
        HStack(spacing: 8) {
          Circle()
            .fill(.white.opacity(0.22))
            .frame(width: 20, height: 20)
            .overlay {
              Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white)
            }
          Text("更多未读消息")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(Capsule().fill(Theme.Palette.accent))
        .shadow(color: Theme.Palette.accent.opacity(0.28), radius: 10, y: 3)
      }
      .buttonStyle(.plain)
      .padding(.bottom, 8)
    }
  }

  private var profile: some View {
    VStack(spacing: 10) {
      Avatar(
        initial: profileInitial,
        tint: Theme.Palette.avatarTint(1),
        size: Theme.Metric.avatarProfile,
        badge: Theme.Palette.avatarTint(3)
      )
      VStack(spacing: 3) {
        Text(profileName)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(Theme.Palette.textPrimary)
        Text(profilePlan)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 4)
    .padding(.bottom, 14)
  }

  private var footer: some View {
    HStack(spacing: 10) {
      Avatar(initial: "Z", tint: Theme.Palette.avatarTint(2), size: Theme.Metric.avatarRow)
      Text(userName)
        .font(Theme.TypeScale.rowTitle)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 0)
      HStack(spacing: 6) {
        Image(systemName: "bell")
          .font(.system(size: 12))
          .foregroundStyle(Theme.Palette.textSecondary)
          .frame(width: 22, height: 22)
          .background(Circle().fill(Theme.Palette.hover))
        Image(systemName: "square.grid.2x2")
          .font(.system(size: 12))
          .foregroundStyle(Theme.Palette.textSecondary)
          .frame(width: 22, height: 22)
          .background(Circle().fill(Theme.Palette.hover))
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 54)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .padding(.horizontal, Theme.Metric.sidebarInset - 4)
    .padding(.bottom, Theme.Metric.windowInset + 2)
  }

  private func beginSectionRename(_ section: SidebarSection) {
    draftTitle = section.title
    editingSection = section.id
  }

  private func commitSectionRename(_ id: String) {
    let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    editingSection = nil
    guard !title.isEmpty else { return }
    onRenameSection(id, title)
  }

  private func beginItemRename(_ item: SidebarItem) {
    draftTitle = item.title
    editingItem = item.id
  }

  private func commitItemRename(_ id: String) {
    let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    editingItem = nil
    guard !title.isEmpty else { return }
    onRenameItem(id, title)
  }
}
