import SwiftUI

/// Presentation data for the left column. Deliberately dumb: the feature layer
/// owns the groups and maps them onto these sections.
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

public struct SidebarSection: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let count: Int?
  public let isExpanded: Bool
  public let items: [SidebarItem]

  public init(id: String, title: String, count: Int? = nil, isExpanded: Bool = true, items: [SidebarItem]) {
    self.id = id
    self.title = title
    self.count = count
    self.isExpanded = isExpanded
    self.items = items
  }
}
