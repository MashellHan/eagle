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

  public init(
    id: String,
    title: String,
    subtitle: String,
    tag: String? = nil,
    tintIndex: Int = 0,
    face: BotFace.Style? = nil
  ) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.tag = tag
    self.tintIndex = tintIndex
    self.face = face
  }
}

public struct SidebarSection: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let count: Int?
  public let isExpanded: Bool
  public let items: [SidebarItem]

  public init(
    id: String, title: String, count: Int? = nil, isExpanded: Bool = true, items: [SidebarItem]
  ) {
    self.id = id
    self.title = title
    self.count = count
    self.isExpanded = isExpanded
    self.items = items
  }
}
