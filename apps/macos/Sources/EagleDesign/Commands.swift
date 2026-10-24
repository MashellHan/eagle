import Foundation

/// Menu commands post these; the shell listens and animates its columns.
public extension Notification.Name {
  static let eagleToggleSidebar = Notification.Name("ai.hexly.eagle.toggleSidebar")
  static let eagleToggleInspector = Notification.Name("ai.hexly.eagle.toggleInspector")
}
