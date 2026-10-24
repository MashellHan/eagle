import AppKit
import EagleDesign
import EagleFeatures
import SwiftUI

/// Dependency-free checks. XCTest ships only with full Xcode, and Swift
/// Testing's macro plugin does not load with a Command Line Tools toolchain,
/// so this executable asserts and exits non-zero on the first failure.
///
///     swift run EagleChecks
@main
struct EagleChecks {
  @MainActor
  static func main() {
    var failures = 0
    func check(_ name: String, _ condition: @autoclosure () -> Bool, _ detail: String = "") {
      if condition() {
        print("  ok   \(name)")
        return
      }
      failures += 1
      print("  FAIL \(name)\(detail.isEmpty ? "" : " — \(detail)")")
    }

    func expectColor(_ name: String, _ color: Color, _ hex: UInt32) {
      guard let actual = NSColor(color).usingColorSpace(.sRGB) else {
        failures += 1
        print("  FAIL \(name) — not convertible to sRGB")
        return
      }
      let red = CGFloat((hex >> 16) & 0xFF) / 255
      let green = CGFloat((hex >> 8) & 0xFF) / 255
      let blue = CGFloat(hex & 0xFF) / 255
      let close =
        abs(actual.redComponent - red) < 0.004
        && abs(actual.greenComponent - green) < 0.004
        && abs(actual.blueComponent - blue) < 0.004
      check("\(name) = #\(String(hex, radix: 16, uppercase: true))", close)
    }

    print("design tokens")
    check("sidebar width 374", Theme.Metric.sidebarWidth == 374)
    check("inspector width 319", Theme.Metric.inspectorWidth == 319)
    check("row height 58", Theme.Metric.rowHeight == 58)
    check("composer height 54", Theme.Metric.composerHeight == 54)
    check("inspector row height 40", Theme.Metric.inspectorRowHeight == 40)
    check("card radius 12", Theme.Metric.cardRadius == 12)
    check("row avatar 34", Theme.Metric.avatarRow == 34)
    check("inspector avatar 76", Theme.Metric.avatarInspector == 76)
    check("content width 720", Theme.Metric.conversationMaxContentWidth == 720)

    check("content inset 20", Theme.Metric.contentInset == 20)
    check("row pitch 58", Theme.Metric.rowHeight == 58)
    check("section header 24", Theme.Metric.sectionHeaderHeight == 24)
    check("section gap 22", Theme.Metric.sectionGap == 22)
    check("profile avatar 55", Theme.Metric.profileAvatar == 55)
    check("toolbar 36 tall", Theme.Metric.toolbarHeight == 36)
    check("unread pill 28", Theme.Metric.unreadPillHeight == 28)
    check("footer card 62", Theme.Metric.footerHeight == 62)

    print("palette")
    expectColor("canvas", Theme.Palette.canvas, 0xF7F7F5)
    expectColor("surface", Theme.Palette.surface, 0xFFFFFF)
    expectColor("card", Theme.Palette.card, 0xFFFFFF)
    expectColor("line", Theme.Palette.line, 0xECECEA)
    expectColor("textPrimary", Theme.Palette.textPrimary, 0x252525)
    expectColor("textSecondary", Theme.Palette.textSecondary, 0x757575)
    expectColor("textMuted", Theme.Palette.textMuted, 0xA7A7A7)
    expectColor("accent", Theme.Palette.accent, 0x3B7DCD)
    expectColor("accentFill", Theme.Palette.accentFill, 0x4FA46A)
    expectColor("accentStrong", Theme.Palette.accentStrong, 0x58B378)
    check("avatar tints rotate", Theme.Palette.avatarTints.count == 7)

    // LocalState wraps a StateObject, which SwiftUI only installs inside a view
    // graph. The box itself is what carries the value, so exercise it directly.
    print("local state shim")
    let box = LocalStateStorage(1)
    check("reads initial value", box.value == 1)
    box.value = 7
    check("writes propagate", box.value == 7)
    let list = LocalStateStorage(["a"])
    list.value.append("b")
    check("collections mutate in place", list.value == ["a", "b"])

    print("workspace list")
    let workspace = WorkspaceListViewModel()
    workspace.select("knowledge")
    check("selection stored", workspace.selection == "knowledge")
    check("selection resolves item", workspace.selectedItem?.title == "知识库")
    workspace.select("missing")
    check("unknown selection has no item", workspace.selectedItem == nil)
    check("mock groups are populated", workspace.groups.allSatisfy { !$0.items.isEmpty })

    print("chat")
    let chat = ChatViewModel(entries: [])
    chat.draft = "  今天 eagle 会修吗  "
    chat.send()
    check("send appends two rows", chat.entries.count == 2)
    if case .user(let id, let text) = chat.entries.first {
      check("user turn identifier", id == "local-0")
      check("draft trimmed", text == "今天 eagle 会修吗")
    } else {
      failures += 1
      print("  FAIL first entry is a user turn")
    }
    check("typing row follows", chat.entries.last?.id == "typing-0")
    check("draft cleared", chat.draft.isEmpty)
    check("send counter", chat.sentCount == 1)

    let blank = ChatViewModel(entries: [])
    blank.draft = "  \n "
    blank.send()
    check("blank draft ignored", blank.entries.isEmpty)

    print("group crud")
    let groups = WorkspaceListViewModel()
    let initialSections = groups.sections.count
    groups.toggleSection("review")
    check("collapse hides rows", groups.sections.first { $0.id == "review" }?.isExpanded == false)
    groups.toggleSection("review")
    check("expand shows rows", groups.sections.first { $0.id == "review" }?.isExpanded == true)
    groups.renameSection("review", to: "审查组 A")
    check("rename keeps order", groups.groups.contains { $0.id == "review" && $0.title == "审查组 A" })
    groups.createSection()
    check("create appends", groups.sections.count == initialSections + 1)
    let created = groups.groups.last
    check("new group is named", created?.title.hasPrefix("新分组") == true)
    if let created { groups.deleteSection(created.id) }
    check("delete removes", groups.sections.count == initialSections)
    groups.renameItem("deps", to: "依赖修复专家 A")
    check("item rename", groups.groups.flatMap(\.items).contains { $0.id == "deps" && $0.title == "依赖修复专家 A" })
    let beforeItems = groups.totalConversations
    groups.deleteItem("deps")
    check("item delete", groups.totalConversations == beforeItems - 1)
    check("selection moves on delete", groups.selection != "deps")

    print("layout model")
    let layout = ShellLayoutViewModel()
    layout.resizeSidebar(by: 40)
    check("sidebar grows", layout.sidebarWidth == Theme.Metric.sidebarWidth + 40)
    layout.resizeSidebar(by: -1000)
    check("sidebar clamps low", layout.sidebarWidth == Theme.Metric.sidebarMinWidth)
    layout.resizeInspector(by: -30)
    check("inspector grows when dragged left", layout.inspectorWidth == Theme.Metric.inspectorWidth + 30)
    layout.resizeInspector(by: 1000)
    check("inspector clamps high", layout.inspectorWidth == Theme.Metric.inspectorMinWidth)
    layout.toggleSidebar()
    check("sidebar collapses", layout.showsSidebar == false)
    layout.toggleSidebar()
    check("sidebar returns", layout.showsSidebar == true)

    print("inspector")
    let inspector = InspectorViewModel()
    let first = inspector.jobs[0]
    inspector.setJob(first.id, isOn: !first.isOn)
    check("job toggled", inspector.jobs[0].isOn == !first.isOn)
    check("job detail preserved", inspector.jobs[0].detail == first.detail)
    let before = inspector.jobs
    inspector.setJob("nope", isOn: true)
    check("unknown job ignored", inspector.jobs == before)
    check("default tab", inspector.tab == .detail)

    print("")
    if failures == 0 {
      print("EagleChecks: all checks passed")
      return
    }
    print("EagleChecks: \(failures) check(s) failed")
    exit(1)
  }
}
