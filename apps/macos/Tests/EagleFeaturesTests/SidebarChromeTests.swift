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

  @Test("decoration keeps what the section is, so a group stays a group")
  func keepsRole() {
    let model = SidebarChromeViewModel()
    let group = SidebarSection(
      id: "g_1", title: "工作", items: [SidebarItem(id: "b_1", title: "一", subtitle: "")],
      role: .group)
    let ungrouped = SidebarSection(
      id: "bots.ungrouped", title: "未分组", items: [], role: .ungrouped)
    #expect(model.decorate(group).role == .group)
    #expect(model.decorate(ungrouped).role == .ungrouped)
    #expect(model.decorate(group).deleteBlockedReason == "组内还有 1 个 Bot，先移走再删除")
  }

  @Test("a working bot keeps its busy flag through decoration, so its face can move")
  func keepsBusy() {
    let model = SidebarChromeViewModel()
    let section = SidebarSection(
      id: "g_1", title: "工作",
      items: [SidebarItem(id: "b_1", title: "一", subtitle: "", busy: true)],
      role: .group)
    #expect(model.decorate(section).items.first?.busy == true)
    model.togglePin("b_1")
    model.markUnread("b_1")
    #expect(model.decorate(section).items.first?.busy == true)
  }
}
