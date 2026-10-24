import SwiftUI

/// Presentation data for the left column. Deliberately dumb: the feature layer
/// maps Herdr Spaces onto these rows later.
public struct SidebarItem: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let subtitle: String
  public let tag: String?
  public let tintIndex: Int

  public init(id: String, title: String, subtitle: String, tag: String? = nil, tintIndex: Int = 0) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.tag = tag
    self.tintIndex = tintIndex
  }
}

public struct SidebarGroup: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let count: Int?
  public let items: [SidebarItem]

  public init(id: String, title: String, count: Int? = nil, items: [SidebarItem]) {
    self.id = id
    self.title = title
    self.count = count
    self.items = items
  }
}

/// A single conversation row: avatar, bold title, muted subtitle, optional tag.
public struct ConversationRow: View {
  private let item: SidebarItem
  private let selected: Bool
  @LocalState private var hovering = false

  public init(item: SidebarItem, selected: Bool) {
    self.item = item
    self.selected = selected
  }

  public var body: some View {
    HStack(spacing: 10) {
      Avatar(initial: String(item.title.prefix(1)), tint: Theme.Palette.avatarTint(item.tintIndex))
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(item.title)
            .font(Theme.TypeScale.rowTitle)
            .foregroundStyle(Theme.Palette.textPrimary)
            .lineLimit(1)
          if let tag = item.tag {
            Tag(tag)
          }
        }
        Text(item.subtitle)
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(Theme.Palette.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .frame(height: Theme.Metric.rowHeight)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(selected ? Theme.Palette.card : (hovering ? Theme.Palette.hover : .clear))
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .strokeBorder(selected ? Theme.Palette.line : .clear, lineWidth: Theme.Metric.hairline)
    )
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .accessibilityElement(children: .combine)
  }
}
