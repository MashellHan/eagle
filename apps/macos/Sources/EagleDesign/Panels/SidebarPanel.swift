import SwiftUI

/// Left column: window actions, organization header, grouped conversations,
/// unread banner and the current user row. Collapses with a slide transition.
public struct SidebarPanel: View {
  private let profileInitial: String
  private let profileName: String
  private let profilePlan: String
  private let groups: [SidebarGroup]
  private let selection: String?
  private let onSelect: (String) -> Void
  private let onSearch: () -> Void
  private let onCompose: () -> Void
  private let onCollapse: () -> Void
  private let unreadCount: Int
  private let onUnread: () -> Void
  private let userName: String
  private let reservesTrafficLights: Bool

  public init(
    profileInitial: String,
    profileName: String,
    profilePlan: String,
    groups: [SidebarGroup],
    selection: String?,
    onSelect: @escaping (String) -> Void,
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
    self.groups = groups
    self.selection = selection
    self.onSelect = onSelect
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
      HStack(spacing: 4) {
        IconButton(systemName: "sidebar.left", label: "收起侧栏", action: onCollapse)
        Spacer(minLength: 0)
        IconButton(systemName: "magnifyingglass", label: "搜索", action: onSearch)
        IconButton(systemName: "square.and.pencil", label: "新建会话", action: onCompose)
      }
      .padding(.horizontal, Theme.Metric.sidebarInset - 8)
      .padding(.top, reservesTrafficLights ? Theme.Metric.trafficLightInset : 8)
      .frame(height: Theme.Metric.headerHeight + (reservesTrafficLights ? Theme.Metric.trafficLightInset : 0))

      profile

      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(groups) { group in
              SectionLabel(group.title, count: group.count)
                .padding(.horizontal, Theme.Metric.rowInset)
                .padding(.top, Theme.Metric.sectionGap)
              ForEach(group.items) { item in
                Button {
                  withAnimation(.easeOut(duration: 0.16)) { onSelect(item.id) }
                } label: {
                  ConversationRow(item: item, selected: item.id == selection)
                }
                .buttonStyle(.plain)
                .id(item.id)
              }
            }
          }
          .padding(.horizontal, Theme.Metric.sidebarInset - Theme.Metric.rowInset)
          .padding(.bottom, 16)
        }
        .scrollIndicators(.never)
        .onAppear {
          if let selection { proxy.scrollTo(selection, anchor: .center) }
        }
      }

      footer
    }
    .frame(width: Theme.Metric.sidebarWidth)
    .frame(maxHeight: .infinity)
    .background(Theme.Palette.canvas)
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
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.Palette.textPrimary)
        Text(profilePlan)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 6)
    .padding(.bottom, 18)
  }

  private var footer: some View {
    VStack(spacing: 8) {
      if unreadCount > 0 {
        HStack(spacing: 10) {
          Circle()
            .fill(Theme.Palette.accentFill)
            .frame(width: 20, height: 20)
            .overlay {
              Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white)
            }
          Text("\(unreadCount) 条未读消息")
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
          Spacer(minLength: 0)
          TextAction("更多未读消息", action: onUnread)
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(
          RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
            .fill(Theme.Palette.card)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
            .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
      }

      HStack(spacing: 10) {
        Avatar(initial: "Z", tint: Theme.Palette.avatarTint(2))
        Text(userName)
          .font(Theme.TypeScale.rowTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Spacer(minLength: 0)
        Image(systemName: "bell")
          .font(.system(size: 12))
          .foregroundStyle(Theme.Palette.textSecondary)
        Image(systemName: "square.grid.2x2")
          .font(.system(size: 12))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 12)
      .frame(height: 56)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
    }
    .padding(.horizontal, Theme.Metric.sidebarInset - 8)
    .padding(.bottom, 14)
  }
}
