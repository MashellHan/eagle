import Testing

@testable import EagleDesign
@testable import EagleFeatures

/// The sidebar's real groups: one section per daemon group in the daemon's order, one
/// fixed 未分组 section when a bot is unfiled, and the sample groups only after them.
@Suite("Sidebar groups")
struct SidebarGroupTests {
  private func row(_ id: String, group: String?) -> SidebarBotRow {
    SidebarBotRow(groupId: group, item: SidebarItem(id: id, title: id, subtitle: ""))
  }

  private let groups = [
    SidebarItemGroup(id: "g_1", title: "工作"),
    SidebarItemGroup(id: "g_2", title: "研究"),
    SidebarItemGroup(id: "g_3", title: "空组"),
  ]

  @Test("one section per group, in the daemon's order, empty groups included")
  func sections() {
    let sections = SidebarComposition.groupSections(
      rows: [row("b_1", group: "g_1"), row("b_2", group: "g_2"), row("b_3", group: "g_1")],
      groups: groups
    )
    #expect(sections.map(\.id) == ["g_1", "g_2", "g_3"])
    #expect(sections.map(\.title) == ["工作", "研究", "空组"])
    #expect(sections[0].items.map(\.id) == ["b_1", "b_3"], "rows keep the catalog's order")
    #expect(sections[1].items.map(\.id) == ["b_2"])
    #expect(sections[2].items.isEmpty, "an empty group is still the person's to rename or delete")
    #expect(sections.allSatisfy { $0.role == .group })
    #expect(sections.allSatisfy { $0.isExpanded })
  }

  @Test("unfiled bots live in one fixed 未分组 section at the end")
  func ungrouped() {
    let sections = SidebarComposition.groupSections(
      rows: [row("b_1", group: "g_1"), row("b_2", group: nil), row("b_3", group: "g_gone")],
      groups: groups
    )
    let ungrouped = sections.last
    #expect(ungrouped?.id == SidebarComposition.ungroupedSectionID)
    #expect(ungrouped?.title == "未分组")
    #expect(ungrouped?.role == .ungrouped)
    #expect(
      ungrouped?.items.map(\.id) == ["b_2", "b_3"],
      "a membership pointing at a missing group reads as ungrouped"
    )
    #expect(sections.count == 4)
  }

  @Test("没有未归组的 bot 时不显示未分组")
  func noUngroupedSectionWhenEmpty() {
    let sections = SidebarComposition.groupSections(
      rows: [row("b_1", group: "g_1")],
      groups: groups
    )
    #expect(sections.map(\.id) == ["g_1", "g_2", "g_3"])
    #expect(sections.contains { $0.role == .ungrouped } == false)
    #expect(SidebarComposition.groupSections(rows: [], groups: []).isEmpty)
  }

  @Test("a collapsed group stays collapsed across a republish")
  func collapsed() {
    var collapsed: Set<String> = ["g_2"]
    let first = SidebarComposition.groupSections(
      rows: [row("b_1", group: "g_1")], groups: groups, collapsed: collapsed)
    #expect(first.first { $0.id == "g_2" }?.isExpanded == false)
    collapsed.insert("g_1")
    let second = SidebarComposition.groupSections(
      rows: [row("b_2", group: "g_1")], groups: groups, collapsed: collapsed)
    #expect(second.first { $0.id == "g_1" }?.isExpanded == false)
    #expect(second.first { $0.id == "g_1" }?.items.map(\.id) == ["b_2"])
  }

  @Test("sample groups follow the real ones, 未分组 included, only when switched on")
  func mockOrder() {
    let real = SidebarComposition.groupSections(
      rows: [row("b_1", group: "g_1"), row("b_2", group: nil)],
      groups: groups
    )
    let sample = [SidebarSection(id: "secretariat", title: "秘书处", items: [])]
    #expect(
      SidebarComposition.sections(botSections: real, mock: sample, showsMock: true).map(\.id)
        == ["g_1", "g_2", "g_3", SidebarComposition.ungroupedSectionID, "secretariat"]
    )
    #expect(
      SidebarComposition.sections(botSections: real, mock: sample, showsMock: false).map(\.id)
        == ["g_1", "g_2", "g_3", SidebarComposition.ungroupedSectionID]
    )
  }

  @Test("a new group is named so it is not confused with an existing one")
  func newGroupTitle() {
    #expect(SidebarComposition.newGroupTitle(existing: []) == "新分组")
    #expect(SidebarComposition.newGroupTitle(existing: ["工作"]) == "新分组")
    #expect(SidebarComposition.newGroupTitle(existing: ["新分组"]) == "新分组 2")
    #expect(SidebarComposition.newGroupTitle(existing: ["新分组", "新分组 2"]) == "新分组 3")
    #expect(SidebarComposition.newGroupTitle(existing: ["新分组", "新分组 3"]) == "新分组 2")
  }

  @Test("上移 and 下移 exchange neighbours and refuse the ends")
  func reorder() {
    let ids = ["g_1", "g_2", "g_3"]
    #expect(SidebarComposition.moved(ids, moving: "g_2", by: -1) == ["g_2", "g_1", "g_3"])
    #expect(SidebarComposition.moved(ids, moving: "g_2", by: 1) == ["g_1", "g_3", "g_2"])
    #expect(SidebarComposition.moved(ids, moving: "g_1", by: -1) == nil, "the first cannot move up")
    #expect(SidebarComposition.moved(ids, moving: "g_3", by: 1) == nil, "the last cannot move down")
    #expect(SidebarComposition.moved(ids, moving: "g_gone", by: 1) == nil)
    #expect(SidebarComposition.moved([], moving: "g_1", by: 1) == nil)
    #expect(SidebarComposition.moved(["g_1"], moving: "g_1", by: 1) == nil)
  }

  @Test("a drop files the bot under the section it lands on")
  func dropTarget() {
    let work = SidebarSection(
      id: "g_1", title: "工作", items: [], role: .group)
    let ungrouped = SidebarSection(
      id: SidebarComposition.ungroupedSectionID, title: "未分组", items: [], role: .ungrouped)
    let sample = SidebarSection(id: "secretariat", title: "秘书处", items: [])

    #expect(
      SidebarComposition.dropOutcome(on: work, from: "g_2") == .move(groupId: "g_1"),
      "a bot from another group moves"
    )
    #expect(
      SidebarComposition.dropOutcome(on: work, from: nil) == .move(groupId: "g_1"),
      "an unfiled bot moves"
    )
    #expect(
      SidebarComposition.dropOutcome(on: work, from: "g_1") == .none,
      "dropping on its own group is not a write"
    )
    #expect(
      SidebarComposition.dropOutcome(on: ungrouped, from: "g_1") == .move(groupId: nil),
      "dropping on 未分组 clears the membership"
    )
    #expect(SidebarComposition.dropOutcome(on: ungrouped, from: nil) == .none)
    #expect(
      SidebarComposition.dropOutcome(on: sample, from: "g_1") == .none,
      "a sample section is not a group"
    )
  }

  @Test("deleting a group that still holds a bot is refused with the reason")
  func deleteGuard() {
    let bot = SidebarItem(id: "b_1", title: "一", subtitle: "")
    let full = SidebarSection(id: "g_1", title: "工作", items: [bot], role: .group)
    let empty = SidebarSection(id: "g_2", title: "空组", items: [], role: .group)
    let ungrouped = SidebarSection(
      id: SidebarComposition.ungroupedSectionID, title: "未分组", items: [], role: .ungrouped)
    let sample = SidebarSection(id: "secretariat", title: "秘书处", items: [bot])

    #expect(full.deleteBlockedReason == "组内还有 1 个 Bot，先移走再删除")
    #expect(empty.deleteBlockedReason == nil)
    #expect(ungrouped.deleteBlockedReason == "未分组不能删除")
    #expect(sample.deleteBlockedReason == nil, "a sample section is client-only")
  }
}
