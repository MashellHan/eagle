import Foundation

/// Menu commands post these; the shell listens and animates its columns.
extension Notification.Name {
  public static let eagleToggleSidebar = Notification.Name("ai.hexly.eagle.toggleSidebar")
  public static let eagleToggleInspector = Notification.Name("ai.hexly.eagle.toggleInspector")
}
