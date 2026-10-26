import Testing

@testable import EagleDesign
@testable import EagleFeatures

@MainActor
@Suite("Sidebar unread groups")
struct SidebarChromeTests {
  @Test("group badges count visible unread conversations instead of all rows")
  func unreadGroups() {
    let model = SidebarChromeViewModel()
    let section = SidebarSection(
      id: "group", title: "Group",
      items: [
        SidebarItem(id: "a", title: "A", subtitle: "Latest A"),
        SidebarItem(id: "b", title: "B", subtitle: "Latest B"),
      ])
    model.markUnread("a")
    #expect(model.decorate(section).unreadCount == 1)
    model.markRead("a")
    #expect(model.decorate(section).unreadCount == 0)
    model.markUnread("b")
    model.hide("b")
    #expect(model.decorate(section).unreadCount == 0)
  }
}
