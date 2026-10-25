import SwiftUI

/// Left column on the reference grid: traffic lights at (16, 15), toolbar at
/// 36 pt, profile avatar 55 pt starting at 79, first section header at 214,
/// 58 pt rows, unread pill at 28 pt and a 62 pt user card.
public struct SidebarPanel: View {
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
  private let onAccount: () -> Void
  private let unreadCount: Int
  private let onUnread: () -> Void
  private let userName: String
  private let width: CGFloat

  @State private var editingSection: String?
  @State private var editingItem: String?
  @State private var draftTitle = ""
  @State private var hoveringSection: String?

  public init(
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
    onAccount: @escaping () -> Void = {},
    unreadCount: Int = 0,
    onUnread: @escaping () -> Void = {},
    userName: String = "Zheng Li"
  ) {
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
    self.onAccount = onAccount
    self.unreadCount = unreadCount
    self.onUnread = onUnread
    self.userName = userName
  }

  private static var version: String {
    (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      BrandHeader(
        version: Self.version,
        onSearch: onSearch,
        onCompose: onCompose,
        onCollapse: onCollapse
      )
      list
      footer
    }
    .frame(width: width)
    .frame(maxHeight: .infinity)
    .background(Theme.Palette.canvas)
  }

  private var list: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
            sectionHeader(section, isFirst: index == 0)
            if section.isExpanded {
              VStack(alignment: .leading, spacing: 2) {
                ForEach(section.items) { item in
                  row(item)
                    .transition(.opacity)
                }
              }
              .animation(.easeInOut(duration: 0.18), value: section.isExpanded)
            }
          }
        }
        .padding(.horizontal, Theme.Metric.listCardInset)
        .padding(.top, Theme.Metric.edgeFadeHeight + 8)
        .padding(.bottom, 8)
      }
      .scrollIndicators(.never)
      .scrollEdgeFades(
        Theme.Palette.canvas, top: Theme.Metric.edgeFadeHeight, bottom: Theme.Metric.edgeFadeHeight
      )
      .overlay(alignment: .bottom) { unreadPill }
      .onChange(of: selection) {
        guard let selection else { return }
        withAnimation(.easeOut(duration: 0.16)) {
          proxy.scrollTo(selection, anchor: .center)
        }
      }
    }
  }

  private func sectionHeader(_ section: SidebarSection, isFirst: Bool) -> some View {
    HStack(spacing: 6) {
      Button {
        withAnimation(.snappy(duration: 0.22)) { onToggleSection(section.id) }
      } label: {
        HStack(spacing: 5) {
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(Theme.Palette.textSecondary.opacity(0.75))
            .rotationEffect(.degrees(section.isExpanded ? 90 : 0))
            // The collapse control is always visible: a group's state should be readable
            // without hovering.
            .opacity(section.isExpanded ? 0.8 : 0.5)
            .frame(width: 9)
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
    .padding(.leading, Theme.Metric.rowContentInset)
    .padding(.trailing, Theme.Metric.rowContentInset)
    .frame(height: Theme.Metric.sectionHeaderHeight, alignment: .top)
    .padding(.top, isFirst ? 0 : Theme.Metric.sectionGap)
    .onHover { hoveringSection = $0 ? section.id : nil }
    .animation(.easeOut(duration: 0.12), value: section.isExpanded)
    .animation(.easeOut(duration: 0.12), value: hoveringSection)
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
          .padding(.leading, Theme.Metric.contentInset)
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
      Button("重命名 Bot") { beginItemRename(item) }
      Divider()
      Button("删除 Bot", role: .destructive) { onDeleteItem(item.id) }
    }
  }

  @ViewBuilder
  private var unreadPill: some View {
    if unreadCount > 0 {
      Button(action: onUnread) {
        HStack(spacing: 8) {
          Circle()
            .fill(.white.opacity(0.22))
            .frame(width: 18, height: 18)
            .overlay {
              Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.white)
            }
          Text("更多未读消息")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white)
        }
        .padding(.horizontal, 11)
        .frame(height: Theme.Metric.unreadPillHeight)
        .background(Capsule().fill(Theme.Palette.accent))
        .shadow(color: Theme.Palette.accent.opacity(0.28), radius: 10, y: 3)
      }
      .buttonStyle(.plain)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.bottom, Theme.Metric.unreadPillBottom)
    }
  }

  /// No card and no border: the avatar lines up with the list avatars at the
  /// shared 20 pt content inset.
  private var footer: some View {
    Button(action: onAccount) {
      footerContent
    }
    .buttonStyle(.plain)
    .accessibilityLabel("账户与设置")
  }

  private var footerContent: some View {
    HStack(spacing: Theme.Metric.rowAvatarGap) {
      Avatar(initial: "Z", tint: Theme.Palette.avatarTint(2), size: Theme.Metric.avatarRow)
      Text(userName)
        .font(Theme.TypeScale.rowTitle)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 0)
      HStack(spacing: 12) {
        Image(systemName: "bell")
          .font(.system(size: 13))
          .foregroundStyle(Theme.Palette.textSecondary)
        Image(systemName: "square.grid.2x2")
          .font(.system(size: 13))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .padding(.leading, Theme.Metric.contentInset)
    .padding(.trailing, Theme.Metric.contentInset)
    .frame(height: Theme.Metric.footerHeight)
    .padding(.bottom, Theme.Metric.footerBottom)
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
