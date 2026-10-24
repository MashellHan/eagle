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
