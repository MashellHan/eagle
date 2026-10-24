import SwiftUI

/// Left column: window actions, organization header, grouped conversations,
/// unread banner and the current user row.
public struct SidebarPanel: View {
  private let profileInitial: String
  private let profileName: String
  private let profilePlan: String
  private let groups: [SidebarGroup]
  private let selection: String?
  private let onSelect: (String) -> Void
  private let onSearch: () -> Void
  private let onCompose: () -> Void
  private let unreadCount: Int
  private let onUnread: () -> Void
  private let userName: String

  public init(
    profileInitial: String,
    profileName: String,
    profilePlan: String,
    groups: [SidebarGroup],
    selection: String?,
    onSelect: @escaping (String) -> Void,
    onSearch: @escaping () -> Void = {},
    onCompose: @escaping () -> Void = {},
    unreadCount: Int = 0,
    onUnread: @escaping () -> Void = {},
    userName: String = "Zheng Li"
  ) {
    self.profileInitial = profileInitial
    self.profileName = profileName
    self.profilePlan = profilePlan
    self.groups = groups
    self.selection = selection
    self.onSelect = onSelect
    self.onSearch = onSearch
    self.onCompose = onCompose
    self.unreadCount = unreadCount
    self.onUnread = onUnread
    self.userName = userName
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Spacer(minLength: 0)
        IconButton(systemName: "magnifyingglass", label: "搜索", action: onSearch)
        IconButton(systemName: "plus", label: "新建会话", action: onCompose)
      }
      .padding(.horizontal, Theme.Metric.sidebarInset - 6)
      .frame(height: Theme.Metric.headerHeight)

      profile

      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(groups) { group in
            SectionLabel(group.title, count: group.count)
              .padding(.top, Theme.Metric.sectionGap)
            ForEach(group.items) { item in
              Button {
                onSelect(item.id)
              } label: {
                ConversationRow(item: item, selected: item.id == selection)
              }
              .buttonStyle(.plain)
            }
          }
        }
        .padding(.horizontal, Theme.Metric.sidebarInset - 10)
        .padding(.bottom, 12)
      }
      .scrollIndicators(.never)

      footer
    }
    .frame(width: Theme.Metric.sidebarWidth)
    .frame(maxHeight: .infinity)
    .background(Theme.Palette.canvas)
  }

  private var profile: some View {
    VStack(spacing: 8) {
      Avatar(
        initial: profileInitial,
        tint: Theme.Palette.avatarTint(1),
        size: Theme.Metric.avatarProfile,
        badge: Theme.Palette.avatarTint(3)
      )
      VStack(spacing: 2) {
        Text(profileName)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Theme.Palette.textPrimary)
        Text(profilePlan)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 14)
  }

  private var footer: some View {
    VStack(spacing: 0) {
      if unreadCount > 0 {
        HStack(spacing: 10) {
          Circle()
            .fill(Theme.Palette.accentFill)
            .frame(width: 18, height: 18)
            .overlay {
              Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.white)
            }
          Text("\(unreadCount) 条未读消息")
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
          Spacer(minLength: 0)
          TextAction("更多未读消息", action: onUnread)
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(
          RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
            .fill(Theme.Palette.card)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
            .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
      }

      HStack(spacing: 10) {
        Avatar(initial: "Z", tint: Theme.Palette.avatarTint(2))
        Text(userName)
          .font(Theme.TypeScale.rowTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Spacer(minLength: 0)
        Image(systemName: "bell")
          .font(.system(size: 11))
          .foregroundStyle(Theme.Palette.textSecondary)
        Image(systemName: "square.grid.2x2")
          .font(.system(size: 11))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 12)
      .frame(height: 52)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
      .padding(.horizontal, 10)
    }
    .padding(.bottom, 10)
  }
}
