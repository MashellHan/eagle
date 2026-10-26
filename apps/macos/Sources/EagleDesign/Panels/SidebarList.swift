import SwiftUI

/// Presentation data for the left column. Deliberately dumb: the feature layer
/// owns the groups and maps them onto these sections.
public struct SidebarItem: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let subtitle: String
  public let tag: String?
  public let tintIndex: Int
  /// A bot draws its own face instead of the circled initial.
  public let face: BotFace.Style?
  /// Pinned rows sort first and show a pin next to the title.
  public let pinned: Bool
  /// Unread rows carry the accent dot at the trailing edge.
  public let unread: Bool

  public init(
    id: String,
    title: String,
    subtitle: String,
    tag: String? = nil,
    tintIndex: Int = 0,
    face: BotFace.Style? = nil,
    pinned: Bool = false,
    unread: Bool = false
  ) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.tag = tag
    self.tintIndex = tintIndex
    self.face = face
    self.pinned = pinned
    self.unread = unread
  }
}

public struct SidebarSection: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public var unreadCount: Int { items.filter(\.unread).count }
  public let isExpanded: Bool
  public let items: [SidebarItem]

  public init(
    id: String, title: String, isExpanded: Bool = true, items: [SidebarItem]
  ) {
    self.id = id
    self.title = title
    self.isExpanded = isExpanded
    self.items = items
  }
}

/// One group a row can be moved to (the context menu's submenu).
public struct SidebarItemGroup: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}
